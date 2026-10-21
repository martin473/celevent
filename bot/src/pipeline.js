import { collect } from './collect.js'
import { reviewPending, localToday } from './review.js'
import { repostAccepted } from './repost.js'
import { startRun, finishRun } from './store.js'
import { percentile, errMsg } from './log.js'

/**
 * One batch run: collect -> dedupe + LLM review -> repost.
 *
 * Every dependency is passed in (db, Bluesky client, LLM call, clock) so the
 * whole run can be exercised in tests with fakes.
 *
 * Run stats are written to the `runs` table and logged as one summary line,
 * including ingest lag (post created -> collected) and end-to-end latency
 * (post created -> reposted). Those two numbers are the health check: if they
 * climb, sources are failing or the schedule is too sparse.
 */
export async function runOnce({ db, bsky, config, log, createMessage, now = new Date() }) {
  const runId = await startRun(db, 'batch')
  const runLog = log.child({ run_id: Number(runId) })
  const today = localToday(config.region.timezone, now)
  const stats = { today }
  const started = performance.now()
  let ok = false

  try {
    const c = await runLog.trace('stage.collect', {}, () =>
      collect({ db, bsky, config, log: runLog, now }),
    )
    stats.collect = c.stats
    stats.ingest_lag_sec = summarize(c.lagsSec)

    stats.review = await runLog.trace('stage.review', {}, () =>
      reviewPending({ db, config, log: runLog, createMessage, today }),
    )

    const r = await runLog.trace('stage.repost', {}, () =>
      repostAccepted({ db, bsky, config, log: runLog, today, now }),
    )
    stats.repost = r.stats
    stats.post_to_repost_sec = summarize(r.latenciesSec)
    ok = stats.collect.source_errors < stats.collect.sources || stats.collect.sources === 0
  } catch (err) {
    stats.error = errMsg(err)
    throw err
  } finally {
    stats.duration_ms = Math.round(performance.now() - started)
    await finishRun(db, runId, { ok, stats }).catch(() => {})
    runLog.info('run summary', { ok, ...stats })
  }
  return { runId, ok, stats }
}

function summarize(values) {
  if (!values.length) return null
  return {
    n: values.length,
    p50: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    max: Math.round(Math.max(...values)),
  }
}
