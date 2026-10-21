#!/usr/bin/env node
import { loadConfig } from './config.js'
import { connect, migrate } from './db.js'
import { createLogger, errMsg } from './log.js'
import { connectBluesky } from './bsky.js'
import { llmClient } from './review.js'
import { runOnce } from './pipeline.js'
import { recentRuns, recentDecisions, upcomingAccepted, rejectCounts } from './store.js'
import { localToday } from './review.js'

const USAGE = `celevent-bot <command>

  migrate            create/upgrade the Postgres schema
  login <handle>     one-time OAuth (DPoP) sign-in for the bot account
  run                one batch: collect -> LLM review -> repost
  loop               run every loop.interval_minutes until stopped
  stream             live Jetstream collector (pair with loop or cron'd run)
  status             recent runs and review decisions

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
        const createMessage = llmClient(config.env)
        const everyMs = config.loop.interval_minutes * 60e3
        while (!shutdown.signal.aborted) {
          try {
            await runOnce({ db, bsky, config, log, createMessage, now: new Date() })
          } catch (err) {
            log.error('run failed', { error: errMsg(err) })
          }
          await sleep(everyMs, shutdown.signal)
        }
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
