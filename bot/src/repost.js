import { repostQueue, repostsSince, saveRepost } from './store.js'
import { errMsg } from './log.js'

/**
 * Repost accepted events, soonest first, within per-run and per-day caps.
 * In dry-run mode the decision is recorded (dry_run = true) but nothing is
 * written to Bluesky, so you can watch a few runs before going live.
 *
 * Returns per-post latency from first sighting to repost for the run stats.
 */
export async function repostAccepted({ db, bsky, config, log, today, now = new Date() }) {
  const { max_per_run, max_per_day, dry_run: dryRun } = config.repost
  const stats = { reposted: 0, dry_run: dryRun, skipped_same_event: 0, errors: 0, cap_hit: false }
  const latenciesSec = []

  const dayAgo = new Date(now - 864e5)
  const usedToday = await repostsSince(db, dayAgo, { dryRun })
  const budget = Math.max(0, Math.min(max_per_run, max_per_day - usedToday))
  if (budget === 0) {
    stats.cap_hit = true
    log.info('repost cap reached', { used_today: usedToday, max_per_day })
    return { stats, latenciesSec }
  }

  // Over-fetch: some rows may share an event with one reposted earlier this run.
  const queue = await repostQueue(db, { today, limit: budget * 3, dryRun })
  const keysThisRun = new Set()

  for (const item of queue) {
    if (stats.reposted >= budget) { stats.cap_hit = true; break }
    if (item.event_key && keysThisRun.has(item.event_key)) {
      stats.skipped_same_event++
      continue
    }
    const span = log.span('repost.one', { uri: item.uri, title: item.title, date: item.event_date, dry_run: dryRun })
    try {
      const repostUri = dryRun ? null : await bsky.repost(item.uri, item.cid)
      const saved = await saveRepost(db, { uri: item.uri, repostUri, eventKey: item.event_key, dryRun })
      if (!saved) { span.end({ already: true }); continue }
      if (item.event_key) keysThisRun.add(item.event_key)
      stats.reposted++
      latenciesSec.push((now - new Date(item.created_at)) / 1000)
      span.end({ repost_uri: repostUri })
    } catch (err) {
      stats.errors++
      span.fail(err)
      // Deleted posts and blocks fail forever; record them so they leave the queue.
      if (/not found|could not locate|blocked/i.test(errMsg(err))) {
        await saveRepost(db, { uri: item.uri, repostUri: null, eventKey: null, dryRun })
      }
    }
  }
  return { stats, latenciesSec }
}
