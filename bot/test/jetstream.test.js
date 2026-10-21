import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runJetstream } from '../src/jetstream.js'
import { kvGet } from '../src/store.js'
import { memoryLogger } from '../src/log.js'
import { freshDb, testConfig, TEST_DATABASE_URL } from './helpers.js'

const skip = !TEST_DATABASE_URL && 'set TEST_DATABASE_URL to run Postgres integration tests'
let db
beforeEach(async () => { if (!skip) db = await freshDb() })
afterEach(async () => { await db?.end(); db = null })

const NOW = new Date('2026-10-21T16:00:00Z')
let rk = 0
const evt = ({ did = 'did:plc:someone', text, lagMs = 1500, op = 'create', collection = 'app.bsky.feed.post' }) => ({
  did,
  time_us: (NOW.getTime() - lagMs) * 1000 + rk,
  kind: 'commit',
  commit: {
    operation: op, collection, rkey: `3k${++rk}`, cid: `bafy${rk}`,
    record: { $type: collection, text, createdAt: new Date(NOW - lagMs).toISOString() },
  },
})

/** A WebSocket stand-in that replays a script of events, then closes. */
function scriptedSocket(script, urls) {
  return (url) => {
    urls.push(url)
    const ws = { close: () => ws.onclose?.() }
    queueMicrotask(async () => {
      ws.onopen?.()
      for (const e of script.shift() ?? []) ws.onmessage({ data: JSON.stringify(e) })
      ws.onclose?.()
    })
    return ws
  }
}

test('jetstream keeps matching posts, checkpoints the cursor, and resumes with rewind', { skip }, async () => {
  const config = testConfig({ jetstream: { checkpoint_seconds: 3600, rewind_seconds: 5 } })
  const match = evt({ text: 'pittsburgh show tonight at Brillobox, doors 8pm' })
  const noise = evt({ text: 'just had the best sandwich' })
  const like = evt({ text: '', collection: 'app.bsky.feed.like' })
  const trusted = evt({ did: 'did:plc:venue', text: 'Friday: doors 8pm, $10' })
  const urls = []
  const ac = new AbortController()
  const script = [[match, noise, like], [trusted]]
  const connect = scriptedSocket(script, urls)
  const bsky = {
    did: 'did:plc:bot',
    getFollows: async () => ({ follows: [{ did: 'did:plc:venue', handle: 'venue.bsky.social' }] }),
  }
  const log = memoryLogger()

  // Stop after the second connection has drained.
  const origSetTimeout = globalThis.setTimeout
  let reconnects = 0
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000 && ms <= 60e3) { // reconnect backoff: skip the wait
      if (++reconnects >= 2) ac.abort()
      return origSetTimeout(fn, 0, ...rest)
    }
    return origSetTimeout(fn, ms, ...rest)
  }
  try {
    await runJetstream({ db, bsky, config, log, connect, signal: ac.signal, now: () => NOW })
  } finally {
    globalThis.setTimeout = origSetTimeout
  }

  const rows = (await db.query('select uri, status, sources from candidates order by uri')).rows
  assert.deepEqual(rows.map((r) => r.uri).sort(), [
    `at://${match.did}/app.bsky.feed.post/${match.commit.rkey}`,
    `at://did:plc:venue/app.bsky.feed.post/${trusted.commit.rkey}`,
  ].sort())
  assert.ok(rows.every((r) => r.status === 'pending' && r.sources[0] === 'jetstream'))

  // first connect is live; the reconnect resumes 5s before the last cursor
  assert.ok(!new URL(urls[0]).searchParams.has('cursor'))
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), String(like.time_us - 5e6))
  assert.equal(Number(await kvGet(db, 'cursor:jetstream')), trusted.time_us)

  const cp = log.lines.filter((l) => l.msg === 'jetstream checkpoint').at(-1)
  assert.equal(cp.lag_ms_p50 >= 1000 && cp.lag_ms_p50 <= 2000, true)
})
