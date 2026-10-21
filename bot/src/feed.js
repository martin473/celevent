import { localToday } from './review.js'
import { kvGet } from './store.js'

/**
 * Custom feed: "Pittsburgh shows this week".
 *
 * A Bluesky feed generator is a service that answers getFeedSkeleton with a
 * list of post URIs; the Bluesky AppView hydrates them into full posts. This
 * one is identified by did:web:<PUBLIC_URL host> and lists every show the
 * pipeline knows about in the next `feed.days` days, soonest first:
 *   - posts the LLM review accepted (the original venue/band/fan post), and
 *   - the bot's own posts for shows scraped from venue websites.
 *
 * The feed is published by writing an app.bsky.feed.generator record to the
 * bot's repo (`npm run publish-feed`), which points at this service's DID.
 */

export function feedConfig(config) {
  const url = config.env.publicUrl
  if (!url) return null
  const host = new URL(url).host
  return {
    serviceDid: `did:web:${host}`,
    endpoint: `https://${host}`,
    rkey: config.feed?.rkey ?? 'pgh-shows',
    days: config.feed?.days ?? 7,
    displayName: config.feed?.display_name ?? 'Pittsburgh Shows This Week',
    description: config.feed?.description ?? 'Upcoming live music in Pittsburgh over the next 7 days.',
  }
}

export async function feedUri(db, fc) {
  const did = await kvGet(db, 'bot:did')
  return did ? `at://${did}/app.bsky.feed.generator/${fc.rkey}` : null
}

export function didDocument(fc) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: fc.serviceDid,
    service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: fc.endpoint }],
  }
}

/**
 * One row per event (same show from several sources collapses to one),
 * soonest first. Cursor is an opaque offset; the list is small and changes
 * slowly, so keyset pagination isn't worth the complexity.
 */
export async function feedSkeleton(db, { config, limit = 50, cursor, now = new Date() }) {
  const fc = feedConfig(config)
  const today = localToday(config.region.timezone, now)
  const offset = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
  const n = Math.min(Math.max(1, Number(limit) || 50), 100)

  const { rows } = await db.query(
    `with items as (
       select r.uri as post, r.event_date, coalesce(r.event_key, r.uri) as k, 0 as pref, c.created_at as at
       from reviews r join candidates c on c.uri = r.uri
       where r.accepted and r.event_date between $1::date and $1::date + $2::int
       union all
       select o.post_uri, s.event_date, s.event_key, 1, o.posted_at
       from own_posts o join scraped_events s on s.event_key = o.event_key
       where not o.dry_run and o.post_uri is not null
         and s.event_date between $1::date and $1::date + $2::int
     ), one_per_event as (
       select distinct on (k) post, event_date, at from items order by k, pref, at
     )
     select post from one_per_event
     order by event_date, at, post
     offset $3 limit $4`,
    [today, fc?.days ?? 7, offset, n + 1],
  )
  const page = rows.slice(0, n)
  return {
    feed: page.map((r) => ({ post: r.post })),
    ...(rows.length > n ? { cursor: String(offset + n) } : {}),
  }
}
