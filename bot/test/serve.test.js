import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../src/server.js'
import { feedSkeleton } from '../src/feed.js'
import { runProblems, alertOnRun, health } from '../src/health.js'
import { kvSet, kvGet } from '../src/store.js'
import { memoryLogger } from '../src/log.js'
import { freshDb, testConfig, TEST_DATABASE_URL } from './helpers.js'

const skip = !TEST_DATABASE_URL && 'set TEST_DATABASE_URL to run Postgres integration tests'
const NOW = new Date('2026-10-21T16:00:00Z')
const BOT = 'did:plc:bot'
const FEED = `at://${BOT}/app.bsky.feed.generator/pgh-shows`

let db
beforeEach(async () => { if (!skip) db = await freshDb() })
afterEach(async () => { await db?.end(); db = null })

const cfg = (o = {}) => {
  const c = testConfig(o)
  c.env.publicUrl = 'https://feed.example'
  c.env.adminToken = 'sekrit'
  c.env.identifier = 'bot.test'
  return c
}

async function seedEvents() {
  await kvSet(db, 'bot:did', BOT)
  const cand = (uri, at) => db.query(
    `insert into candidates (uri, cid, author_did, text, created_at, text_hash, status) values ($1,'c','did:x','t',$2,$1,'reviewed')`, [uri, at])
  const review = (uri, date, key, accepted = true) => db.query(
    `insert into reviews (uri, is_event, is_local, confidence, event_date, event_key, accepted, model) values ($1,true,true,0.9,$2,$3,$4,'m')`, [uri, date, key, accepted])
  await cand('at://a/p/soon', '2026-10-20T10:00:00Z'); await review('at://a/p/soon', '2026-10-22', 'k-soon')
  await cand('at://a/p/later', '2026-10-20T11:00:00Z'); await review('at://a/p/later', '2026-10-26', 'k-later')
  await cand('at://a/p/far', '2026-10-20T12:00:00Z'); await review('at://a/p/far', '2026-11-20', 'k-far')
  await cand('at://a/p/rejected', '2026-10-20T13:00:00Z'); await review('at://a/p/rejected', '2026-10-23', 'k-rej', false)
  // scraped shows: one live post, one dry-run, one duplicating a reviewed event
  const ev = (key, date) => db.query(
    `insert into scraped_events (event_key, title, venue, event_date, source_url) values ($1,'t','v',$2,'https://v')`, [key, date])
  await ev('k-scraped', '2026-10-24'); await ev('k-dry', '2026-10-25'); await ev('k-soon', '2026-10-22')
  await db.query(`insert into own_posts (event_key, dry_run, post_uri, text) values ('k-scraped', false, 'at://${BOT}/p/own1', 'x')`)
  await db.query(`insert into own_posts (event_key, dry_run, post_uri, text) values ('k-dry', true, null, 'x')`)
  await db.query(`insert into own_posts (event_key, dry_run, post_uri, text) values ('k-soon', false, 'at://${BOT}/p/own2', 'x')`)
}

test('feed skeleton: one post per event this week, soonest first, paginated', { skip }, async () => {
  await seedEvents()
  const config = cfg()
  const all = await feedSkeleton(db, { config, now: NOW })
  // k-soon appears once (the original post wins over our own); far, rejected, and dry-run are excluded
  assert.deepEqual(all.feed.map((f) => f.post), ['at://a/p/soon', `at://${BOT}/p/own1`, 'at://a/p/later'])
  assert.equal(all.cursor, undefined)

  const p1 = await feedSkeleton(db, { config, now: NOW, limit: 2 })
  assert.equal(p1.feed.length, 2)
  const p2 = await feedSkeleton(db, { config, now: NOW, limit: 2, cursor: p1.cursor })
  assert.deepEqual(p2.feed.map((f) => f.post), ['at://a/p/later'])
  assert.equal(p2.cursor, undefined)
})

async function withServer(config, opts, fn) {
  const server = await startServer({ db, config, log: memoryLogger(), port: 0, ...opts })
  const base = `http://127.0.0.1:${server.address().port}`
  try { return await fn(base) } finally { await new Promise((r) => server.close(r)) }
}

test('server: did:web document, feed description, and skeleton', { skip }, async () => {
  await seedEvents()
  await withServer(cfg(), {}, async (base) => {
    const did = await (await fetch(`${base}/.well-known/did.json`)).json()
    assert.equal(did.id, 'did:web:feed.example')
    assert.deepEqual(did.service[0], { id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: 'https://feed.example' })

    const desc = await (await fetch(`${base}/xrpc/app.bsky.feed.describeFeedGenerator`)).json()
    assert.deepEqual(desc, { did: 'did:web:feed.example', feeds: [{ uri: FEED }] })

    const bad = await fetch(`${base}/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://someone/else`)
    assert.equal(bad.status, 400)
    const ok = await fetch(`${base}/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(FEED)}&limit=10`)
    assert.equal(ok.status, 200)
    assert.ok(Array.isArray((await ok.json()).feed))
  })
})

test('server: healthz and metrics', { skip }, async () => {
  const config = cfg()
  await withServer(config, {}, async (base) => {
    let r = await fetch(`${base}/healthz`)
    assert.equal(r.status, 200) // just started, no runs yet
    assert.equal((await r.json()).reason, 'starting')

    await db.query(`insert into runs (kind, started_at, finished_at, ok, stats) values ('batch', now(), now(), false, '{}')`)
    r = await fetch(`${base}/healthz`)
    assert.equal(r.status, 503)
    assert.equal((await r.json()).reason, 'last run failed')

    await db.query(`insert into runs (kind, started_at, finished_at, ok, stats) values ('batch', now(), now(), true, '{"ingest_lag_sec":{"n":5,"p50":120,"p95":600}}')`)
    r = await fetch(`${base}/healthz`)
    assert.equal(r.status, 200)

    const m = await (await fetch(`${base}/metrics`)).text()
    assert.match(m, /^celevent_up 1$/m)
    assert.match(m, /^celevent_ingest_lag_p50_seconds 120$/m)
    assert.match(m, /^celevent_runs_failed_total 1$/m)
  })
})

test('health fails when no run finished within 3 intervals', { skip }, async () => {
  const config = cfg()
  await db.query(`insert into runs (kind, started_at, finished_at, ok, stats) values ('batch', $1, $1, true, '{}')`, [new Date(NOW - 2 * 36e5)])
  const h = await health(db, config, NOW, NOW.getTime() - 5 * 36e5)
  assert.equal(h.healthy, false)
  assert.equal(h.reason, 'last run too old')
})

test('server: OAuth routes are gated and only accept the bot account', { skip }, async () => {
  await kvSet(db, 'bot:did', BOT)
  const revoked = []
  const fakeClient = {
    clientMetadata: { client_id: 'https://feed.example/oauth/client-metadata.json' },
    jwks: { keys: [{ kty: 'EC', kid: 'celevent-1' }] },
    authorize: async (handle) => new URL(`https://pds.example/authorize?handle=${handle}`),
    callback: async (params) => ({ session: { did: params.get('who') } }),
    revoke: async (did) => { revoked.push(did) },
  }
  await withServer(cfg(), { getOAuthClient: async () => fakeClient }, async (base) => {
    assert.equal((await (await fetch(`${base}/oauth/client-metadata.json`)).json()).client_id, fakeClient.clientMetadata.client_id)
    assert.equal((await (await fetch(`${base}/oauth/jwks.json`)).json()).keys[0].kid, 'celevent-1')

    assert.equal((await fetch(`${base}/oauth/login`, { redirect: 'manual' })).status, 403)
    assert.equal((await fetch(`${base}/oauth/login?token=wrong`, { redirect: 'manual' })).status, 403)
    const go = await fetch(`${base}/oauth/login?token=sekrit`, { redirect: 'manual' })
    assert.equal(go.status, 302)
    assert.equal(go.headers.get('location'), 'https://pds.example/authorize?handle=bot.test')

    const intruder = await fetch(`${base}/oauth/callback?who=did:plc:someoneelse`)
    assert.equal(intruder.status, 403)
    assert.deepEqual(revoked, ['did:plc:someoneelse'])
    assert.equal(await kvGet(db, 'oauth:default_did'), undefined)

    const me = await fetch(`${base}/oauth/callback?who=${BOT}`)
    assert.equal(me.status, 200)
    assert.equal(await kvGet(db, 'oauth:default_did'), BOT)
  })
})

test('alert rules', () => {
  const config = testConfig()
  const keys = (stats, ok = true) => runProblems(stats, { ok, config }).map((p) => p.key)
  assert.deepEqual(keys({}, false), ['run_failed'])
  assert.deepEqual(keys({ review: { llm_errors: 1 } }), ['llm_errors'])
  assert.deepEqual(keys({ collect: { sources: 10, source_errors: 5 } }), ['source_errors'])
  assert.deepEqual(keys({ collect: { sources: 10, source_errors: 1 } }), [])
  assert.deepEqual(keys({ ingest_lag_sec: { n: 10, p50: 9000 } }), ['ingest_lag'])
  assert.deepEqual(keys({ ingest_lag_sec: { n: 1, p50: 9000 } }), []) // too few posts to mean anything
})

test('alerts respect the cooldown and announce recovery', { skip }, async () => {
  const config = testConfig()
  config.env.alertWebhookUrl = 'https://discord.com/api/webhooks/1/abc'
  const sent = []
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).content); return { ok: true } }
  const log = memoryLogger()
  const fail = { review: { llm_errors: 2 } }

  assert.deepEqual(await alertOnRun({ db, config, log, stats: fail, ok: true, fetchImpl, now: NOW }), ['llm_errors'])
  assert.deepEqual(await alertOnRun({ db, config, log, stats: fail, ok: true, fetchImpl, now: new Date(NOW.getTime() + 20 * 6e4) }), [])
  assert.deepEqual(await alertOnRun({ db, config, log, stats: fail, ok: true, fetchImpl, now: new Date(NOW.getTime() + 61 * 6e4) }), ['llm_errors'])
  assert.deepEqual(await alertOnRun({ db, config, log, stats: {}, ok: true, fetchImpl, now: new Date(NOW.getTime() + 80 * 6e4) }), ['recovered'])
  assert.deepEqual(await alertOnRun({ db, config, log, stats: {}, ok: true, fetchImpl, now: new Date(NOW.getTime() + 100 * 6e4) }), [])
  assert.equal(sent.length, 3)
  assert.match(sent[0], /^⚠️ celevent-bot: LLM review failed in 2 batch/)
  assert.match(sent[2], /healthy again/)
})
