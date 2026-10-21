#!/usr/bin/env node
import { loadConfig } from './config.js'
import { connect, migrate } from './db.js'
import { createLogger, errMsg } from './log.js'
import { connectBluesky } from './bsky.js'
import { llmClient } from './review.js'
import { ollamaApi } from './ollama.js'
import { runOnce } from './pipeline.js'
import { recentRuns, recentDecisions, upcomingAccepted, rejectCounts, kvGet, kvSet } from './store.js'
import { localToday } from './review.js'

const USAGE = `celevent-bot <command>

  migrate            create/upgrade the Postgres schema
  login <handle>     one-time OAuth (DPoP) sign-in for the bot account
  run                one batch: collect -> LLM review -> repost
  loop               run every loop.interval_minutes until stopped
  stream             live Jetstream collector (pair with loop or cron'd run)
  discover [name]    find venue/aggregator Bluesky accounts + events pages (Ollama web search)
                     --force re-checks everything; a name limits it to matching targets
  scrape             scrape venue events pages now and post upcoming shows
  directory          what discovery found for each venue and aggregator
  status             recent runs and review decisions
  serve              production mode: HTTP server (feed, OAuth, /healthz, /metrics)
                     + the loop + optional Jetstream, all in one process
  publish-feed       register the "Pittsburgh shows this week" feed on the bot account
  oauth-keygen       print a new private key for OAUTH_PRIVATE_KEY

env: DATABASE_URL, DRY_RUN, an LLM (OLLAMA_API_KEY or ANTHROPIC_API_KEY), and either
     BSKY_IDENTIFIER + BSKY_APP_PASSWORD, or an OAuth login (BSKY_AUTH=oauth)`

async function main([cmd, ...args]) {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE)
    return
  }
  const config = loadConfig()
  const log = createLogger({ base: { svc: 'celevent-bot', cmd } })
  const db = await connect(config.env.databaseUrl)
  const shutdown = new AbortController()
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => shutdown.abort())

  try {
    await migrate(db, { log })
    switch (cmd) {
      case 'migrate':
        log.info('schema up to date')
        break

      case 'login': {
        const handle = args[0] ?? config.env.identifier
        if (!handle) throw new Error('usage: celevent-bot login <handle>')
        const { interactiveLogin } = await import('./oauth.js')
        await interactiveLogin({ db, config, log, handle })
        break
      }

      case 'run': {
        const bsky = await connectBluesky({ db, config, log })
        const createMessage = llmClient(config.env)
        const { ok } = await runOnce({ db, bsky, config, log, createMessage })
        process.exitCode = ok ? 0 : 1
        break
      }

      case 'loop': {
        const bsky = await connectBluesky({ db, config, log })
        await runLoop({ db, bsky, config, log, signal: shutdown.signal })
        break
      }

      case 'serve': {
        const { startServer } = await import('./server.js')
        const { createOAuthClient } = await import('./oauth.js')
        let oauthClient
        const getOAuthClient = async () => {
          if (!config.env.publicUrl || !config.env.oauthPrivateKey) return null
          return (oauthClient ??= await createOAuthClient({ db, config }))
        }
        // The server comes up first, so /oauth/login works even before the bot
        // has a session, and /healthz reports while Bluesky is unreachable.
        const server = await startServer({ db, config, log, getOAuthClient })
        let bsky = null
        while (!bsky && !shutdown.signal.aborted) {
          bsky = await connectBluesky({ db, config, log }).catch(async (err) => {
            log.error('bluesky connect failed, retrying in 60s', { error: errMsg(err) })
            const { sendAlert } = await import('./health.js')
            if (config.env.alertWebhookUrl) await sendAlert(config.env.alertWebhookUrl, `⚠️ celevent-bot can't sign in to Bluesky: ${errMsg(err)}`, { log })
            await sleep(60e3, shutdown.signal)
            return null
          })
        }
        const tasks = []
        if (bsky) tasks.push(runLoop({ db, bsky, config, log, signal: shutdown.signal }))
        if (bsky && (config.env.jetstream ?? config.serve?.jetstream)) {
          const { runJetstream } = await import('./jetstream.js')
          tasks.push(runJetstream({ db, bsky, config, log: log.child({ component: 'jetstream' }), signal: shutdown.signal }))
        }
        await Promise.all(tasks)
        await new Promise((r) => server.close(r))
        break
      }

      case 'publish-feed': {
        const { feedConfig } = await import('./feed.js')
        const fc = feedConfig(config)
        if (!fc) throw new Error('set PUBLIC_URL to the HTTPS address the feed server runs at')
        const bsky = await connectBluesky({ db, config, log })
        const uri = await bsky.putRecord({
          collection: 'app.bsky.feed.generator',
          rkey: fc.rkey,
          record: {
            $type: 'app.bsky.feed.generator',
            did: fc.serviceDid,
            displayName: fc.displayName,
            description: fc.description,
            createdAt: new Date().toISOString(),
          },
        })
        log.info('feed published', { uri, service: fc.serviceDid })
        console.log(`\nFeed published: https://bsky.app/profile/${bsky.did}/feed/${fc.rkey}`)
        break
      }

      case 'oauth-keygen': {
        const { generateClientKey } = await import('./oauth.js')
        console.log(`OAUTH_PRIVATE_KEY='${await generateClientKey()}'`)
        break
      }

      case 'stream': {
        const { runJetstream } = await import('./jetstream.js')
        // Bluesky auth is optional here; it only enables "trust followed accounts".
        const bsky = await connectBluesky({ db, config, log }).catch((err) => {
          log.warn('stream running without bsky auth', { error: errMsg(err) })
          return null
        })
        await runJetstream({ db, bsky, config, log, signal: shutdown.signal })
        break
      }

      case 'discover': {
        if (!config.env.ollamaApiKey) throw new Error('discover uses Ollama web search: set OLLAMA_API_KEY')
        const { discoverAll } = await import('./discover.js')
        const bsky = await connectBluesky({ db, config, log })
        const only = args.find((a) => !a.startsWith('--'))
        await discoverAll({ db, bsky, ollama: makeOllama(config), config, log, force: args.includes('--force'), only })
        await kvSet(db, 'discover:last_run', new Date().toISOString())
        await printDirectory(db)
        break
      }

      case 'scrape': {
        const { scrapeAndPost } = await import('./scrape.js')
        const bsky = await connectBluesky({ db, config, log })
        const stats = await scrapeAndPost({ db, bsky, config, log, createMessage: llmClient(config.env), force: true })
        log.info('scrape summary', stats)
        break
      }

      case 'directory':
        await printDirectory(db)
        break

      case 'status': {
        const runs = await recentRuns(db, 10)
        console.log('\nRecent runs')
        for (const r of runs) {
          const s = r.stats ?? {}
          console.log(
            `  #${r.id} ${new Date(r.started_at).toISOString()} ${r.ok ? 'ok ' : 'ERR'}` +
            `  new=${s.collect?.new ?? '-'} pending=${s.collect?.pending ?? '-'}` +
            `  reviewed=${s.review?.reviewed ?? '-'} accepted=${s.review?.accepted ?? '-'}` +
            `  reposted=${s.repost?.reposted ?? '-'}${s.repost?.dry_run ? ' (dry)' : ''}` +
            `  own_posts=${s.scrape?.posted ?? '-'}` +
            `  lag_p50=${s.ingest_lag_sec?.p50 ?? '-'}s  ${s.duration_ms ?? '-'}ms`,
          )
        }
        const today = localToday(config.region.timezone)
        const upcoming = await upcomingAccepted(db, { today })
        console.log(`\nUpcoming accepted events (${upcoming.length})  RT = reposted, dry = would repost`)
        for (const d of upcoming) {
          const mark = d.reposted ? 'RT ' : d.dry_reposted ? 'dry' : '   '
          console.log(
            `  ${mark} ${d.event_date}  ${d.title ?? '(no title)'}${d.venue ? ' @ ' + d.venue : ''}` +
            `  [${Number(d.confidence).toFixed(2)}]  @${d.author_handle ?? '?'}`,
          )
          console.log(`        https://bsky.app/profile/${d.uri.split('/')[2]}/post/${d.uri.split('/').pop()}`)
        }
        const counts = await rejectCounts(db, { since: new Date(Date.now() - 864e5) })
        console.log('\nRejected in the last 24h: ' + (counts.map((c) => `${c.reject_code} ${c.n}`).join(', ') || 'none'))
        if (args.includes('--all')) {
          console.log('\nRecent decisions')
          for (const d of await recentDecisions(db, 40)) {
            const mark = d.accepted ? 'ok ' : '-- '
            console.log(
              `  ${mark}${(d.event_date ?? '????-??-??')}  ${d.title ?? '(no title)'}` +
              `${d.venue ? ' @ ' + d.venue : ''}  [${d.accepted ? 'accepted' : d.reject_code}` +
              ` ${Number(d.confidence).toFixed(2)}]  @${d.author_handle ?? '?'}  ${d.reason ?? ''}`,
            )
          }
        } else {
          console.log('(npm run status -- --all for every recent decision with reasons)')
        }
        break
      }

      default:
        console.error(USAGE)
        process.exitCode = 2
    }
  } finally {
    await db.end()
  }
}

/** Batch run every loop.interval_minutes, alerts after each run, daily discovery. */
async function runLoop({ db, bsky, config, log, signal }) {
  const { discoverAll } = await import('./discover.js')
  const { alertOnRun } = await import('./health.js')
  const createMessage = llmClient(config.env)
  const everyMs = config.loop.interval_minutes * 60e3
  while (!signal.aborted) {
    let result = { ok: false, stats: {} }
    try {
      result = await runOnce({ db, bsky, config, log, createMessage, now: new Date() })
    } catch (err) {
      log.error('run failed', { error: errMsg(err) })
      result.stats.error = errMsg(err)
    }
    await alertOnRun({ db, config, log, stats: result.stats, ok: result.ok })
      .catch((err) => log.warn('alerting failed', { error: errMsg(err) }))

    // Discovery is slow and changes rarely: at most once a day, only targets
    // older than discover.refresh_days.
    if (config.env.ollamaApiKey) {
      const last = await kvGet(db, 'discover:last_run')
      if (!last || Date.now() - new Date(last) > 864e5) {
        await discoverAll({ db, bsky, ollama: makeOllama(config), config, log })
          .catch((err) => log.error('discover failed', { error: errMsg(err) }))
        await kvSet(db, 'discover:last_run', new Date().toISOString())
      }
    }
    await sleep(everyMs, signal)
  }
}

function makeOllama(config) {
  return ollamaApi({ host: config.env.ollamaHost, apiKey: config.env.ollamaApiKey })
}

async function printDirectory(db) {
  const { rows } = await db.query(
    `select name, kind, handle, did, verified, verify_note, events_url, scrape, followed_at,
            follow_dry_run, last_post_at
     from directory order by kind desc, name`,
  )
  console.log(`\nDirectory (${rows.length})  F = followed, f = would follow (dry run), S = scraping site`)
  for (const r of rows) {
    const flags = `${r.followed_at ? (r.follow_dry_run ? 'f' : 'F') : ' '}${r.scrape ? 'S' : ' '}`
    const acct = r.did ? '@' + r.handle : r.handle ? `(@${r.handle}? ${r.verify_note})` : '(no Bluesky account)'
    console.log(`  ${flags} ${r.kind === 'venue' ? 'venue' : 'aggr '}  ${r.name.padEnd(26)} ${acct}`)
    if (r.events_url) console.log(`              events: ${r.events_url}`)
  }
  const { rows: ev } = await db.query(
    `select s.event_date::text as d, s.title, s.venue,
            exists (select 1 from own_posts o where o.event_key = s.event_key and not o.dry_run) as posted,
            exists (select 1 from own_posts o where o.event_key = s.event_key and o.dry_run) as dry
     from scraped_events s where s.event_date >= current_date and s.is_music
     order by s.event_date limit 25`,
  )
  if (ev.length) {
    console.log(`\nScraped upcoming shows  P = posted, dry = would post`)
    for (const e of ev) console.log(`  ${e.posted ? 'P  ' : e.dry ? 'dry' : '   '} ${e.d}  ${e.title} @ ${e.venue}`)
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

main(process.argv.slice(2)).catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'fatal', error: errMsg(err) }))
  process.exit(1)
})
