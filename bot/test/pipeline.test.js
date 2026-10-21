import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runOnce } from '../src/pipeline.js'
import { memoryLogger } from '../src/log.js'
import { freshDb, testConfig, postView, fakeBsky, fakeLlm, TEST_DATABASE_URL } from './helpers.js'

const skip = !TEST_DATABASE_URL && 'set TEST_DATABASE_URL to run Postgres integration tests'
const NOW = new Date('2026-10-21T16:00:00Z') // Wed Oct 21, noon in Pittsburgh
const hoursAgo = (h) => new Date(NOW - h * 36e5)

// Every test gets its own database, so cursors and reposts never leak between tests.
let db
beforeEach(async () => { if (!skip) db = await freshDb() })
afterEach(async () => { await db?.end(); db = null })

const q = async (sql, params) => (await db.query(sql, params)).rows

/** A stand-in model: recognizes the fixture posts by their text. */
function judge(text) {
  const yes = (o) => ({ is_event: true, is_local: true, confidence: 0.92, reason: 'show announcement', ...o })
  if (/Speedy Ortiz/.test(text)) return yes({ title: 'Speedy Ortiz w/ Dazy', headliner: 'Speedy Ortiz', venue: 'Mr. Smalls', event_date: '2026-10-21', event_time: '7pm doors' })
  if (/Mannequin/.test(text)) return yes({ title: 'Mannequin Pussy', headliner: 'Mannequin Pussy', venue: 'Roxian Theatre', event_date: '2026-10-30' })
  if (/last night/.test(text)) return { is_event: false, is_local: true, confidence: 0.95, reason: 'recap of a past show' }
  if (/maybe a show/.test(text)) return yes({ confidence: 0.4, event_date: '2026-10-25', venue: 'Spirit' })
  if (/SKIPME/.test(text)) return { omit: true }
  return { is_event: false, is_local: false, confidence: 0.9, reason: 'not an event' }
}

test('end to end: collect, dedupe, review, repost', { skip }, async () => {
  const config = testConfig({ repost: { dry_run: false, max_per_run: 10, max_per_day: 40 } })
  const venue = { did: 'did:plc:mrsmalls', handle: 'mrsmalls.bsky.social' }

  const venuePost = postView({ ...venue, text: 'TONIGHT in Pittsburgh: Speedy Ortiz w/ Dazy. Doors 7pm, tix at the door', createdAt: hoursAgo(3) })
  const bandPost = postView({ handle: 'speedyortiz.bsky.social', text: 'pittsburgh!! we play mr smalls tonight, doors at 7. come say hi — Speedy Ortiz', createdAt: hoursAgo(2) })
  const crossPost = postView({ handle: 'fan.bsky.social', text: 'tonight in pittsburgh: Speedy Ortiz w/ Dazy... doors 7pm, tix at the door!!', createdAt: hoursAgo(1) })
  const roxian = postView({ handle: 'promoter.bsky.social', text: 'Just announced: Mannequin Pussy at the Roxian Theatre, Fri Oct 30. Tickets on sale now', createdAt: hoursAgo(5) })
  const recap = postView({ handle: 'fan2.bsky.social', text: 'last night at Spirit was unreal, best show of the year in pittsburgh', createdAt: hoursAgo(4) })
  const unsure = postView({ handle: 'fan3.bsky.social', text: 'maybe a show at spirit sunday?? pittsburgh', createdAt: hoursAgo(4) })
  const seattle = postView({ handle: 'sea.bsky.social', text: 'Show tonight in Seattle at the Crocodile, doors 8pm', createdAt: hoursAgo(1) })
  const old = postView({ handle: 'old.bsky.social', text: 'pittsburgh show tonight 8pm', createdAt: hoursAgo(200) })

  const bsky = fakeBsky({
    follows: [venue],
    authorFeeds: { [venue.did]: [venuePost] },
    search: { 'pittsburgh show': [bandPost, crossPost, roxian, recap, unsure, seattle, old, venuePost] },
  })
  const llm = fakeLlm(judge)
  const log = memoryLogger()

  const { ok, stats } = await runOnce({ db, bsky, config, log, createMessage: llm, now: NOW })
  assert.equal(ok, true)

  // collect: venuePost seen by two sources but stored once
  const [vp] = await q('select sources, status from candidates where uri = $1', [venuePost.uri])
  assert.deepEqual(vp.sources.sort(), ['author:mrsmalls.bsky.social', 'search:pittsburgh show'])
  assert.equal(stats.collect.skipped.no_location_signal, 1) // seattle
  // the 200h-old post is cut off by pagination and never stored
  assert.equal((await q('select 1 from candidates where uri = $1', [old.uri])).length, 0)

  // dedupe: exact-text cross-post never reaches the LLM
  const [cp] = await q('select status from candidates where uri = $1', [crossPost.uri])
  assert.equal(cp.status, 'duplicate')
  const sentToLlm = llm.requests.flatMap((r) => [...r.messages[0].content.matchAll(/<post id/g)]).length
  assert.equal(sentToLlm, 5) // venue, band, roxian, recap, unsure

  // review decisions
  const reviews = Object.fromEntries((await q('select uri, accepted, reject_code from reviews')).map((r) => [r.uri, r]))
  assert.equal(reviews[venuePost.uri].accepted, true)
  assert.equal(reviews[bandPost.uri].accepted, true)
  assert.equal(reviews[roxian.uri].accepted, true)
  assert.equal(reviews[recap.uri].reject_code, 'not_event')
  assert.equal(reviews[unsure.uri].reject_code, 'low_confidence')

  // repost: venue and band posts are the same event, so only the first goes out
  const reposted = bsky.calls.reposts.map((r) => r.uri)
  assert.deepEqual(reposted, [venuePost.uri, roxian.uri])
  assert.equal(stats.repost.reposted, 2)
  assert.equal(stats.repost.skipped_same_event, 1)

  // operability: run row written with lag stats
  const [run] = await q('select ok, stats from runs order by id desc limit 1')
  assert.equal(run.ok, true)
  assert.equal(run.stats.review.accepted, 3)
  assert.ok(run.stats.ingest_lag_sec.p50 > 0)
  assert.ok(log.lines.some((l) => l.span === 'stage.review'))
  assert.ok(log.lines.some((l) => l.msg === 'run summary'))

  // second run: nothing new to review or repost; search resumes from the cursor
  const llm2 = fakeLlm(judge)
  const second = await runOnce({ db, bsky, config, log, createMessage: llm2, now: new Date(NOW.getTime() + 20 * 6e4) })
  assert.equal(llm2.requests.length, 0)
  assert.equal(second.stats.collect.new, 0)
  assert.equal(bsky.calls.reposts.length, 2)
  const lastSearch = bsky.calls.search.at(-1)
  assert.equal(lastSearch.since, new Date(NOW.getTime() - 15 * 6e4).toISOString())
})

test('dry run records decisions, then going live still reposts them', { skip }, async () => {
  const config = testConfig({ repost: { dry_run: true, max_per_run: 10, max_per_day: 40 } })
  const p = postView({ handle: 'p.bsky.social', text: 'Mannequin Pussy pittsburgh roxian fri oct 30 tickets', createdAt: hoursAgo(1) })
  const bsky = fakeBsky({ search: { 'pittsburgh show': [p] } })
  const log = memoryLogger()

  await runOnce({ db, bsky, config, log, createMessage: fakeLlm(judge), now: NOW })
  assert.equal(bsky.calls.reposts.length, 0)
  const [dry] = await q('select dry_run, repost_uri from reposts where uri = $1', [p.uri])
  assert.deepEqual(dry, { dry_run: true, repost_uri: null })

  config.repost.dry_run = false
  const live = await runOnce({ db, bsky, config, log, createMessage: fakeLlm(judge), now: NOW })
  assert.deepEqual(bsky.calls.reposts.map((r) => r.uri), [p.uri])
  assert.equal(live.stats.review.reviewed, 0) // decision reused, no second LLM call

  // and once live, it's never reposted twice
  await runOnce({ db, bsky, config, log, createMessage: fakeLlm(judge), now: NOW })
  assert.equal(bsky.calls.reposts.length, 1)
})

test('caps, missing decisions, and LLM outages', { skip }, async () => {
  const config = testConfig({ repost: { dry_run: false, max_per_run: 1, max_per_day: 40 }, review: { max_attempts: 2 } })
  const a = postView({ handle: 'a.bsky.social', text: 'pittsburgh show: Speedy Ortiz again?? no wait, Mannequin... SKIPME tonight 8pm', createdAt: hoursAgo(1) })
  const b = postView({ handle: 'b.bsky.social', text: 'pittsburgh show Nov 3 at Brillobox: Wednesday (the band) 9pm', createdAt: hoursAgo(1) })
  const c = postView({ handle: 'c.bsky.social', text: 'pittsburgh show Nov 4 at Spirit: Horse Jumper of Love 8pm', createdAt: hoursAgo(1) })
  const bsky = fakeBsky({ search: { 'pittsburgh show': [a, b, c] } })
  const log = memoryLogger()
  const judge2 = (text) => {
    if (/SKIPME/.test(text)) return { omit: true }
    const m = text.match(/Nov (\d+) at (\w+): (.+?) \d/)
    return { is_event: true, is_local: true, confidence: 0.9, reason: 'r', event_date: `2026-11-0${m[1]}`, venue: m[2], headliner: m[3] }
  }

  const r1 = await runOnce({ db, bsky, config, log, createMessage: fakeLlm(judge2), now: NOW })
  assert.equal(r1.stats.review.missing, 1)
  assert.equal(r1.stats.repost.reposted, 1)
  assert.equal(r1.stats.repost.cap_hit, true)
  const [ca] = await q('select status, review_attempts from candidates where uri = $1', [a.uri])
  assert.deepEqual(ca, { status: 'pending', review_attempts: 1 })

  // LLM down: run completes, error counted, candidate hits max_attempts -> 'error'
  const down = async () => { throw new Error('anthropic 529: overloaded') }
  const r2 = await runOnce({ db, bsky, config, log, createMessage: down, now: NOW })
  assert.equal(r2.stats.review.llm_errors, 1)
  assert.equal(r2.stats.repost.reposted, 1) // queue still drains while the LLM is down
  const [ca2] = await q('select status from candidates where uri = $1', [a.uri])
  assert.equal(ca2.status, 'error')
})

test('a failing source does not stop the others', { skip }, async () => {
  const config = testConfig({ sources: { searches: ['broken', 'pittsburgh show'] } })
  const p = postView({ handle: 'z.bsky.social', text: 'pittsburgh show tonight at Cattivo 9pm', createdAt: hoursAgo(1) })
  const bsky = fakeBsky({ search: { 'pittsburgh show': [p] } })
  const inner = bsky.searchPosts
  bsky.searchPosts = async (args) => {
    if (args.q === 'broken') throw new Error('upstream 502')
    return inner(args)
  }
  const log = memoryLogger()
  const { ok, stats } = await runOnce({ db, bsky, config, log, createMessage: fakeLlm(() => ({ is_event: false, is_local: true, confidence: 1, reason: 'r' })), now: NOW })
  assert.equal(ok, true)
  assert.equal(stats.collect.source_errors, 1)
  assert.equal(stats.collect.new, 1)
  assert.ok(log.lines.some((l) => l.span === 'collect.source' && l.error === 'upstream 502'))
})
