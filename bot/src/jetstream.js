import { fromJetstreamCommit } from './normalize.js'
import { prefilter, compileRegion } from './prefilter.js'
import { upsertCandidate, kvGet, kvSet } from './store.js'
import { resolveAccounts } from './collect.js'
import { percentile, errMsg } from './log.js'

/**
 * Live collector. Subscribes to Jetstream (the JSON firehose) for new posts,
 * runs the same prefilter as the batch sources, and writes matches into
 * `candidates` as pending. The batch run then reviews and reposts them.
 *
 * Jetstream can't filter by text server-side, so this sees every post on the
 * network and drops ~all of them locally. That's fine: it's a few hundred
 * events a second of small JSON.
 *
 * Operability:
 *   - cursor (time_us) is checkpointed to Postgres; on restart we rewind a
 *     few seconds and resume, so nothing is missed (dupes are free: upsert).
 *   - every checkpoint logs ingest lag = now - event time, plus throughput.
 *     If lag climbs, this process is falling behind the network.
 */
export async function runJetstream({
  db, bsky, config, log,
  connect = (url) => new WebSocket(url),
  signal,
  now = () => new Date(),
}) {
  const jc = config.jetstream
  const regionRe = compileRegion(config.region)
  let trustedDids = new Set()
  const refreshAccounts = async () => {
    if (!bsky) return
    try {
      const accounts = await resolveAccounts({ bsky, config, log })
      trustedDids = new Set(accounts.map((a) => a.did))
      log.info('jetstream trusted accounts', { count: trustedDids.size })
    } catch (err) {
      log.warn('jetstream account refresh failed', { error: errMsg(err) })
    }
  }
  await refreshAccounts()
  const accountTimer = setInterval(refreshAccounts, 60 * 60e3)

  let cursor = await kvGet(db, 'cursor:jetstream')
  let window = { events: 0, posts: 0, matched: 0, lagsMs: [] }
  let backoffMs = 1000

  const checkpoint = async () => {
    if (cursor) await kvSet(db, 'cursor:jetstream', cursor)
    const w = window
    window = { events: 0, posts: 0, matched: 0, lagsMs: [] }
    log.info('jetstream checkpoint', {
      cursor,
      events: w.events,
      posts: w.posts,
      matched: w.matched,
      lag_ms_p50: percentile(w.lagsMs, 50),
      lag_ms_max: w.lagsMs.length ? Math.max(...w.lagsMs) : null,
    })
  }
  const checkpointTimer = setInterval(() => {
    checkpoint().catch((err) => log.warn('checkpoint failed', { error: errMsg(err) }))
  }, jc.checkpoint_seconds * 1000)

  const handle = async (raw) => {
    const evt = JSON.parse(raw)
    window.events++
    cursor = evt.time_us
    window.lagsMs.push(now().getTime() - evt.time_us / 1000)
    if (window.lagsMs.length > 5000) window.lagsMs.splice(0, 2500)

    const commit = evt.commit
    if (evt.kind !== 'commit' || commit?.operation !== 'create') return
    if (commit.collection !== 'app.bsky.feed.post') return
    window.posts++

    const c = fromJetstreamCommit(evt)
    const verdict = prefilter(c, { config, regionRe, trustedDids, now: now() })
    if (verdict.status !== 'pending') return // don't store the firehose's rejects
    window.matched++
    await upsertCandidate(db, { ...c, status: 'pending', score: verdict.score })
  }

  try {
    while (!signal?.aborted) {
      const url = new URL(jc.endpoint)
      url.searchParams.set('wantedCollections', 'app.bsky.feed.post')
      if (cursor) url.searchParams.set('cursor', String(cursor - jc.rewind_seconds * 1e6))

      log.info('jetstream connecting', { endpoint: jc.endpoint, resume_from: cursor ?? 'live' })
      const closed = await new Promise((resolve) => {
        const ws = connect(url.toString())
        let chain = Promise.resolve()
        const onAbort = () => ws.close()
        signal?.addEventListener('abort', onAbort, { once: true })
        ws.onopen = () => { backoffMs = 1000 }
        ws.onmessage = (m) => {
          // Serialize handling so cursor order matches DB writes.
          chain = chain.then(() => handle(typeof m.data === 'string' ? m.data : m.data.toString()))
            .catch((err) => log.warn('jetstream event failed', { error: errMsg(err) }))
        }
        ws.onerror = (e) => log.warn('jetstream socket error', { error: e?.message ?? 'error' })
        ws.onclose = () => {
          signal?.removeEventListener('abort', onAbort)
          chain.then(() => resolve('closed'))
        }
      })
      if (signal?.aborted) break
      log.warn('jetstream disconnected, reconnecting', { reason: closed, backoff_ms: backoffMs })
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 60e3)
    }
  } finally {
    clearInterval(checkpointTimer)
    clearInterval(accountTimer)
    await checkpoint()
  }
}
