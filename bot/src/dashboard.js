import { health } from './health.js'
import { feedSkeleton, feedConfig, feedUri } from './feed.js'
import { localToday } from './review.js'

/**
 * /dashboard: one server-rendered page with the bot's health, recent runs
 * (with ingest-lag and duration sparklines), this week's feed, what discovery
 * found, and the latest review decisions. Refreshes itself every minute.
 */
export async function renderDashboard(db, config, now = new Date()) {
  const today = localToday(config.region.timezone, now)
  const h = await health(db, config, now)
  const runs = (await db.query(
    `select id, started_at, finished_at, ok, stats from runs where kind = 'batch' order by id desc limit 30`,
  )).rows
  const upcoming = (await db.query(
    `select * from (
       select r.event_date::text as d, coalesce(r.title, '(untitled)') as title, r.venue, r.uri,
              exists (select 1 from reposts p where p.uri = r.uri and not p.dry_run) as shared, 'repost' as kind
       from reviews r where r.accepted and r.event_date between $1::date and $1::date + 14
       union all
       select s.event_date::text, s.title, s.venue, o.post_uri,
              o.post_uri is not null, 'post'
       from scraped_events s left join own_posts o on o.event_key = s.event_key and not o.dry_run
       where s.is_music and s.event_date between $1::date and $1::date + 14
     ) x order by d, title limit 60`,
    [today],
  )).rows
  const directory = (await db.query(
    `select name, kind, handle, did, events_url, scrape, followed_at, follow_dry_run from directory order by kind desc, name`,
  ).catch(() => ({ rows: [] }))).rows
  const decisions = (await db.query(
    `select r.accepted, r.reject_code, r.title, r.venue, r.event_date::text as d, r.reason, r.uri, c.author_handle
     from reviews r join candidates c on c.uri = r.uri order by r.reviewed_at desc limit 25`,
  )).rows
  const counts = (await db.query(
    `select (select count(*) from reposts where not dry_run)::int as reposts,
            (select count(*) from own_posts where not dry_run)::int as posts,
            (select count(*) from reviews)::int as reviews,
            (select count(*) from reviews where accepted)::int as accepted`,
  )).rows[0]
  const fc = feedConfig(config)
  const fUri = fc ? await feedUri(db, fc) : null
  const feedCount = fc ? (await feedSkeleton(db, { config, limit: 100, now })).feed.length : null

  const chron = [...runs].reverse()
  const lag = chron.map((r) => r.stats?.ingest_lag_sec?.p50 ?? null)
  const dur = chron.map((r) => r.stats?.duration_ms ?? null)

  return page(`
    <header>
      <h1>celevent-bot</h1>
      <span class="pill ${h.healthy ? 'ok' : 'bad'}">${h.healthy ? 'healthy' : 'unhealthy'} · ${esc(h.reason)}</span>
    </header>

    <section class="tiles">
      ${tile('Last run', h.last_run_age_sec != null ? ago(h.last_run_age_sec) : '—')}
      ${tile('Ingest lag p50', h.ingest_lag_p50_sec != null ? dura(h.ingest_lag_p50_sec) : '—')}
      ${tile('Reposts', counts.reposts)}
      ${tile('Own posts', counts.posts)}
      ${tile('Accepted / reviewed', `${counts.accepted} / ${counts.reviews}`)}
      ${tile('In feed this week', feedCount ?? 'feed off')}
    </section>

    <section class="charts">
      <figure><figcaption>Ingest lag p50 per run</figcaption>${spark(lag, dura)}</figure>
      <figure><figcaption>Run duration</figcaption>${spark(dur, (v) => `${(v / 1000).toFixed(0)}s`)}</figure>
    </section>

    <h2>Recent runs</h2>
    <div class="scroll"><table>
      <tr><th>#</th><th>started</th><th></th><th>new</th><th>reviewed</th><th>accepted</th><th>reposted</th><th>posted</th><th>lag p50</th><th>time</th><th>notes</th></tr>
      ${runs.map((r) => {
        const s = r.stats ?? {}
        const notes = [s.error, s.review?.llm_errors ? `${s.review.llm_errors} LLM errors` : '', s.collect?.source_errors ? `${s.collect.source_errors} source errors` : '', s.repost?.dry_run ? 'dry run' : ''].filter(Boolean).join(' · ')
        return `<tr><td>${r.id}</td><td>${fmtTime(r.started_at, config)}</td><td>${r.finished_at ? (r.ok ? '✅' : '❌') : '⏳'}</td>
          <td>${s.collect?.new ?? ''}</td><td>${s.review?.reviewed ?? ''}</td><td>${s.review?.accepted ?? ''}</td>
          <td>${s.repost?.reposted ?? ''}</td><td>${s.scrape?.posted ?? ''}</td>
          <td>${s.ingest_lag_sec?.p50 != null ? dura(s.ingest_lag_sec.p50) : ''}</td>
          <td>${s.duration_ms != null ? `${(s.duration_ms / 1000).toFixed(0)}s` : ''}</td><td class="muted">${esc(notes)}</td></tr>`
      }).join('')}
    </table></div>

    <h2>Upcoming shows (next 14 days)</h2>
    ${fUri ? `<p class="muted">Feed: <a href="https://bsky.app/profile/${esc(fUri.split('/')[2])}/feed/${esc(fc.rkey)}">${esc(fc.displayName)}</a></p>` : ''}
    <div class="scroll"><table>
      <tr><th>date</th><th>show</th><th>venue</th><th>source</th><th></th></tr>
      ${upcoming.map((e) => `<tr><td>${esc(e.d)}</td><td>${e.uri ? `<a href="${postLink(e.uri)}">${esc(e.title)}</a>` : esc(e.title)}</td>
        <td>${esc(e.venue ?? '')}</td><td>${e.kind === 'repost' ? 'Bluesky post' : 'venue site'}</td>
        <td>${e.shared ? (e.kind === 'repost' ? 'reposted' : 'posted') : '<span class="muted">pending</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">nothing yet</td></tr>'}
    </table></div>

    <h2>Sources found by discovery</h2>
    <div class="scroll"><table>
      <tr><th>name</th><th>kind</th><th>Bluesky</th><th>website scraping</th></tr>
      ${directory.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.kind}</td>
        <td>${d.did ? `<a href="https://bsky.app/profile/${esc(d.handle)}">@${esc(d.handle)}</a>${d.followed_at ? (d.follow_dry_run ? ' (would follow)' : ' ✓ followed') : ''}` : '<span class="muted">none</span>'}</td>
        <td>${d.scrape && d.events_url ? `<a href="${esc(d.events_url)}">${esc(hostOf(d.events_url))}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">run discover</td></tr>'}
    </table></div>

    <h2>Latest review decisions</h2>
    <div class="scroll"><table>
      <tr><th></th><th>show</th><th>date</th><th>author</th><th>reason</th></tr>
      ${decisions.map((d) => `<tr><td>${d.accepted ? '✅' : `<span class="muted">${esc(d.reject_code)}</span>`}</td>
        <td><a href="${postLink(d.uri)}">${esc(d.title ?? '(post)')}</a>${d.venue ? ` <span class="muted">@ ${esc(d.venue)}</span>` : ''}</td>
        <td>${esc(d.d ?? '')}</td><td>@${esc(d.author_handle ?? '?')}</td><td class="muted">${esc(d.reason ?? '')}</td></tr>`).join('')}
    </table></div>
  `)
}

function spark(values, fmt) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null)
  if (pts.length < 2) return '<div class="muted empty">not enough runs yet</div>'
  const W = 600, H = 90, P = 6
  const max = Math.max(...pts.map(([, v]) => v)) || 1
  const x = (i) => P + (i / Math.max(1, values.length - 1)) * (W - 2 * P)
  const y = (v) => H - P - (v / max) * (H - 2 * P)
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const [li, lv] = pts.at(-1)
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="trend">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(li)}" cy="${y(lv)}" r="3" fill="var(--accent)"/></svg>
    <div class="muted small">latest ${fmt(lv)} · max ${fmt(max)}</div>`
}

const tile = (label, value) => `<div class="tile"><div class="muted small">${esc(label)}</div><div class="big">${esc(String(value))}</div></div>`
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const postLink = (uri) => { const [, , did, , rkey] = uri.split('/'); return `https://bsky.app/profile/${esc(did)}/post/${esc(rkey)}` }
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
const dura = (sec) => (sec < 120 ? `${Math.round(sec)}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`)
const ago = (sec) => `${dura(sec)} ago`
const fmtTime = (t, config) => new Date(t).toLocaleString('en-US', { timeZone: config.region.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>celevent-bot</title>
<style>
  :root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#76736c; --line:#e6e2da; --card:#fff; --accent:#c2410c; --ok:#15803d; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ecebe6; --muted:#9a978f; --line:#2c2b28; --card:#1c1b19; --accent:#fb923c; --ok:#4ade80; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; max-width:1100px; margin-inline:auto; }
  header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { font-size:20px; margin:0; } h2 { font-size:15px; margin:28px 0 8px; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  .pill { padding:3px 10px; border-radius:999px; font-size:12px; border:1px solid currentColor; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .muted { color:var(--muted); } .small { font-size:12px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-top:16px; }
  .tile, figure { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; margin:0; }
  .big { font-size:22px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums; }
  .charts { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:10px; margin-top:10px; }
  figcaption { font-size:12px; color:var(--muted); margin-bottom:6px; } svg { width:100%; height:90px; display:block; }
  .empty { height:90px; display:grid; place-items:center; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.muted { white-space:normal; min-width:200px; } th { font-weight:500; color:var(--muted); font-size:12px; }
  tr:last-child td { border-bottom:0; }
</style></head><body>${body}</body></html>`
}
