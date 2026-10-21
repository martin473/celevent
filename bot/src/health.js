import { kvGet, kvSet } from './store.js'
import { errMsg } from './log.js'

/**
 * Health, metrics, and alerts for the deployed bot.
 *
 *   /healthz  200 when the last run finished recently and succeeded, else 503.
 *             The host's health check restarts the machine on repeated 503s.
 *   /metrics  Prometheus text, for Grafana Cloud or any scraper, if wanted.
 *   alerts    a webhook (Discord, Slack, or ntfy.sh for phone push) when a
 *             run fails, the LLM errors, sources fail, or ingest lag climbs.
 */

export async function lastRun(db) {
  const { rows } = await db.query(
    `select id, started_at, finished_at, ok, stats from runs where kind = 'batch' order by id desc limit 1`,
  )
  return rows[0] ?? null
}

const PROCESS_STARTED = Date.now()

export async function health(db, config, now = new Date(), startedAt = PROCESS_STARTED) {
  const run = await lastRun(db)
  const maxAgeSec = config.loop.interval_minutes * 60 * 3
  // Right after a deploy the first run hasn't finished yet; don't fail the
  // health check (and trigger a restart loop) during that window.
  const uptimeSec = (now - startedAt) / 1000
  if (!run || (uptimeSec < maxAgeSec && new Date(run.started_at) < startedAt)) {
    return uptimeSec < maxAgeSec
      ? { healthy: true, reason: 'starting', uptime_sec: Math.round(uptimeSec) }
      : { healthy: false, reason: 'no runs yet' }
  }
  const ageSec = Math.round((now - new Date(run.finished_at ?? run.started_at)) / 1000)
  const healthy = Boolean(run.finished_at) && run.ok && ageSec <= maxAgeSec
  return {
    healthy,
    reason: healthy ? 'ok' : !run.finished_at ? 'run in progress or crashed' : !run.ok ? 'last run failed' : 'last run too old',
    last_run_id: Number(run.id),
    last_run_age_sec: ageSec,
    ingest_lag_p50_sec: run.stats?.ingest_lag_sec?.p50 ?? null,
  }
}

export async function metricsText(db, config, now = new Date()) {
  const h = await health(db, config, now)
  const run = await lastRun(db)
  const s = run?.stats ?? {}
  const counts = (await db.query(
    `select
       (select count(*) from runs where kind = 'batch' and ok) as runs_ok,
       (select count(*) from runs where kind = 'batch' and not ok) as runs_failed,
       (select count(*) from reposts where not dry_run) as reposts,
       (select count(*) from own_posts where not dry_run) as own_posts,
       (select count(*) from reviews) as reviews,
       (select count(*) from reviews where accepted) as accepted,
       (select count(*) from directory where followed_at is not null and not follow_dry_run) as follows`,
  )).rows[0]
  const lines = []
  const g = (name, help, value, type = 'gauge') => {
    lines.push(`# HELP celevent_${name} ${help}`, `# TYPE celevent_${name} ${type}`, `celevent_${name} ${value ?? 'NaN'}`)
  }
  g('up', '1 if the last run finished recently and succeeded', h.healthy ? 1 : 0)
  g('last_run_age_seconds', 'Seconds since the last batch run finished', h.last_run_age_sec)
  g('ingest_lag_p50_seconds', 'Median post-created to collected lag, last run', s.ingest_lag_sec?.p50)
  g('ingest_lag_p95_seconds', 'p95 post-created to collected lag, last run', s.ingest_lag_sec?.p95)
  g('post_to_repost_p50_seconds', 'Median post-created to reposted, last run', s.post_to_repost_sec?.p50)
  g('last_run_duration_ms', 'Duration of the last run', s.duration_ms)
  g('last_run_llm_errors', 'LLM errors in the last run', s.review?.llm_errors ?? 0)
  g('last_run_source_errors', 'Failed sources in the last run', s.collect?.source_errors ?? 0)
  g('runs_ok_total', 'Successful runs', counts.runs_ok, 'counter')
  g('runs_failed_total', 'Failed runs', counts.runs_failed, 'counter')
  g('reposts_total', 'Live reposts', counts.reposts, 'counter')
  g('own_posts_total', 'Live posts for scraped shows', counts.own_posts, 'counter')
  g('reviews_total', 'LLM review decisions', counts.reviews, 'counter')
  g('accepted_total', 'Accepted review decisions', counts.accepted, 'counter')
  g('follows_total', 'Accounts followed by discovery', counts.follows, 'counter')
  return lines.join('\n') + '\n'
}

/** Problems worth waking someone up for, from one run's stats. */
export function runProblems(stats, { ok, config }) {
  const a = config.alerts ?? {}
  const out = []
  if (!ok || stats.error) out.push({ key: 'run_failed', text: `run failed${stats.error ? ': ' + stats.error : ''}` })
  if (stats.review?.llm_errors) out.push({ key: 'llm_errors', text: `LLM review failed in ${stats.review.llm_errors} batch(es); posts will retry next run` })
  const c = stats.collect
  if (c?.sources && c.source_errors / c.sources >= (a.source_error_ratio ?? 0.5)) {
    out.push({ key: 'source_errors', text: `${c.source_errors}/${c.sources} sources failed (Bluesky API or auth problem?)` })
  }
  const lag = stats.ingest_lag_sec
  if (lag?.n >= 3 && lag.p50 > (a.ingest_lag_p50_sec ?? 7200)) {
    out.push({ key: 'ingest_lag', text: `ingest lag p50 is ${Math.round(lag.p50 / 60)} min (threshold ${Math.round((a.ingest_lag_p50_sec ?? 7200) / 60)} min)` })
  }
  if (stats.scrape?.error) out.push({ key: 'scrape_failed', text: `scrape stage failed: ${stats.scrape.error}` })
  return out
}

/**
 * Send each problem at most once per cooldown. Also sends a single
 * "recovered" message when a run succeeds after an alert.
 */
export async function alertOnRun({ db, config, log, stats, ok, fetchImpl = fetch, now = new Date() }) {
  const url = config.env.alertWebhookUrl
  if (!url) return []
  const cooldownMs = (config.alerts?.cooldown_minutes ?? 60) * 6e4
  const sent = []
  const problems = runProblems(stats, { ok, config })
  for (const p of problems) {
    const last = await kvGet(db, `alert:${p.key}`)
    if (last && now - new Date(last) < cooldownMs) continue
    await sendAlert(url, `⚠️ celevent-bot: ${p.text}`, { fetchImpl, log })
    await kvSet(db, `alert:${p.key}`, now.toISOString())
    await kvSet(db, 'alert:open', true)
    sent.push(p.key)
  }
  if (!problems.length && (await kvGet(db, 'alert:open'))) {
    await sendAlert(url, '✅ celevent-bot: runs are healthy again', { fetchImpl, log })
    await kvSet(db, 'alert:open', false)
    sent.push('recovered')
  }
  return sent
}

export async function sendAlert(url, text, { fetchImpl = fetch, log } = {}) {
  let init
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) init = json({ content: text })
  else if (/hooks\.slack\.com/.test(url)) init = json({ text })
  else init = { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text } // ntfy.sh and friends
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`webhook ${res.status}`)
  } catch (err) {
    log?.warn('alert send failed', { error: errMsg(err) })
  }
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
