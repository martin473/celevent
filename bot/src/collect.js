import { fromPostView } from './normalize.js'
import { prefilter, compileRegion } from './prefilter.js'
import { upsertCandidate, kvGet, kvSet } from './store.js'
import { errMsg } from './log.js'

/**
 * Batch collection: pull recent posts from every configured source, normalize,
 * prefilter, and upsert into `candidates`. One failing source never stops the
 * others; it's logged and counted.
 *
 * `bsky` is the thin client from bsky.js (or a fake in tests).
 */
export async function collect({ db, bsky, config, log, now = new Date() }) {
  const regionRe = compileRegion(config.region)
  const src = config.sources
  const stats = { sources: 0, source_errors: 0, seen: 0, new: 0, pending: 0, skipped: {} }
  const lagsSec = []

  // Clean up any own posts reviewed before the bot skipped them.
  await db.query(
    `update reviews set accepted = false, reject_code = 'own_post'
     where accepted and uri in (select uri from candidates where author_did = $1)`,
    [bsky.did],
  )

  const accounts = await log.trace('collect.resolve_accounts', {}, () =>
    resolveAccounts({ bsky, config, log }),
  )
  const trustedDids = new Set(accounts.map((a) => a.did))
  const guideWatch = await aggregatorSites(db)

  const ingest = async (posts, source) => {
    for (const post of posts) {
      const c = fromPostView(post, source)
      if (!c.uri || !c.cid || !c.authorDid) continue
      // Searches find the bot's own posts about scraped shows; never review or repost those.
      if (c.authorDid === bsky.did) { stats.own_skipped = (stats.own_skipped ?? 0) + 1; continue }
      stats.seen++
      if (guideWatch.has(c.authorDid)) {
        if (await maybeQueueGuide(db, post, guideWatch.get(c.authorDid))) stats.guides_queued = (stats.guides_queued ?? 0) + 1
      }
      const verdict = prefilter(c, { config, regionRe, trustedDids, now })
      const inserted = await upsertCandidate(db, {
        ...c,
        status: verdict.status,
        score: verdict.score,
        skipReason: verdict.skipReason,
      })
      if (!inserted) continue
      stats.new++
      if (verdict.status === 'pending') {
        stats.pending++
        lagsSec.push((now - c.createdAt) / 1000)
      } else {
        const key = verdict.skipReason.split(':')[0]
        stats.skipped[key] = (stats.skipped[key] ?? 0) + 1
      }
    }
  }

  const since = new Date(now - src.lookback_hours * 36e5)

  // ── followed accounts ─────────────────────────────────────────────────────
  for (const acct of accounts) {
    const source = `author:${acct.handle ?? acct.did}`
    await runSource(source, async () => {
      const cursorKey = `cursor:author:${acct.did}`
      const newestSeen = await kvGet(db, cursorKey)
      const stopAt = newestSeen ? new Date(Math.max(new Date(newestSeen), since)) : since
      const { posts, newest } = await pageUntil(
        (cursor) => bsky.getAuthorFeed({ actor: acct.did, cursor }),
        { stopAt, maxPages: src.max_pages_per_source },
      )
      await ingest(posts, source)
      if (newest) await kvSet(db, cursorKey, newest.toISOString())
      return posts.length
    })
  }

  // ── searches ──────────────────────────────────────────────────────────────
  const queries = [...src.searches]
  if (src.search_venue_names) {
    for (const v of config.region.venues ?? []) queries.push(`"${v}"`)
  }
  for (const q of [...new Set(queries)]) {
    const source = `search:${q}`
    await runSource(source, async () => {
      const cursorKey = `cursor:search:${q}`
      const lastRun = await kvGet(db, cursorKey)
      // Overlap by 15 min: search indexing isn't instant and dupes are free.
      const sinceAt = lastRun ? new Date(Math.max(new Date(lastRun) - 15 * 6e4, since)) : since
      const { posts } = await pageUntil(
        (cursor) => bsky.searchPosts({ q, since: sinceAt.toISOString(), cursor }),
        { stopAt: sinceAt, maxPages: src.max_pages_per_source },
      )
      await ingest(posts, source)
      await kvSet(db, cursorKey, now.toISOString())
      return posts.length
    })
  }

  async function runSource(source, fn) {
    stats.sources++
    const span = log.span('collect.source', { source })
    try {
      const n = await fn()
      span.end({ posts: n })
    } catch (err) {
      stats.source_errors++
      span.fail(err)
    }
  }

  return { stats, lagsSec }
}

// Words that suggest a linked article is an event listing worth scraping.
const GUIDE_WORDS = /\b(events?|guide|things to do|this weekend|weekend|calendar|concerts?|shows?|live music|lineups?|festivals?|what'?s happening|picks)\b/i

/** Followed aggregators (did -> website host), from discovery. */
async function aggregatorSites(db) {
  try {
    const { rows } = await db.query(`select did, website from directory where kind = 'aggregator' and did is not null`)
    const m = new Map()
    for (const r of rows) {
      try { m.set(r.did, r.website ? new URL(r.website).hostname.replace(/^www\./, '') : null) } catch { m.set(r.did, null) }
    }
    return m
  } catch {
    return new Map() // directory table not migrated yet
  }
}

/**
 * When a followed aggregator links an event guide on its own site, queue the
 * page for scraping. The post itself usually covers dozens of shows at once,
 * so the review step rightly rejects it as "not a specific event".
 */
async function maybeQueueGuide(db, post, siteHost) {
  const ext = post.embed?.external ?? post.record?.embed?.external
  if (!ext?.uri) return false
  let host
  try { host = new URL(ext.uri).hostname.replace(/^www\./, '') } catch { return false }
  if (siteHost && host !== siteHost && !host.endsWith('.' + siteHost)) return false
  if (!GUIDE_WORDS.test(`${ext.title ?? ''} ${ext.description ?? ''} ${post.record?.text ?? ''}`)) return false
  const { rows } = await db.query(
    `insert into guide_pages (url, source, title) values ($1, $2, $3) on conflict do nothing returning url`,
    [ext.uri, `bsky:${post.author?.handle ?? post.author?.did}`, (ext.title ?? '').slice(0, 300)],
  )
  return rows.length === 1
}

/**
 * Explicit config accounts plus (optionally) whoever the bot account follows,
 * so sources can be managed by following/unfollowing in the Bluesky app.
 */
export async function resolveAccounts({ bsky, config, log }) {
  const byDid = new Map()
  for (const actor of config.sources.accounts ?? []) {
    try {
      const did = actor.startsWith('did:') ? actor : await bsky.resolveHandle(actor)
      byDid.set(did, { did, handle: actor.startsWith('did:') ? null : actor })
    } catch (err) {
      log.warn('could not resolve account', { actor, error: errMsg(err) })
    }
  }
  if (config.sources.follow_bot_follows) {
    let cursor
    for (let page = 0; page < 20; page++) {
      const { follows, cursor: next } = await bsky.getFollows({ actor: bsky.did, cursor })
      for (const f of follows) byDid.set(f.did, { did: f.did, handle: f.handle })
      if (!next || !follows.length) break
      cursor = next
    }
  }
  return [...byDid.values()]
}

/**
 * Walk a newest-first paginated feed until posts get older than `stopAt` or
 * we hit maxPages. Pinned/reposted items can be out of order, so we only stop
 * on a page whose *every* item is older than stopAt.
 */
export async function pageUntil(fetchPage, { stopAt, maxPages }) {
  const posts = []
  let newest = null
  let cursor
  for (let page = 0; page < maxPages; page++) {
    const { posts: batch, cursor: next } = await fetchPage(cursor)
    let anyFresh = false
    for (const p of batch) {
      const created = new Date(p.record?.createdAt ?? p.indexedAt ?? 0)
      if (created > stopAt) {
        anyFresh = true
        posts.push(p)
        if (!newest || created > newest) newest = created
      }
    }
    if (!anyFresh || !next) break
    cursor = next
  }
  return { posts, newest }
}
