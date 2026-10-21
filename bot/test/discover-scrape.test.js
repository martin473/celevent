import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { discoverAll, verifyAccount } from '../src/discover.js'
import { scrapeAndPost, robotsAllows, extractJsonLd, htmlToText, composePost } from '../src/scrape.js'
import { runToolLoop } from '../src/ollama.js'
import { eventKeyFor } from '../src/review.js'
import { memoryLogger } from '../src/log.js'
import { freshDb, testConfig, TEST_DATABASE_URL } from './helpers.js'

const skip = !TEST_DATABASE_URL && 'set TEST_DATABASE_URL to run Postgres integration tests'
const NOW = new Date('2026-10-21T16:00:00Z')

// ─── unit ────────────────────────────────────────────────────────────────────
test('robots.txt: specific agent group wins, longest rule wins, empty disallow allows', () => {
  const txt = `User-agent: *\nDisallow: /events\nAllow: /events/public\n\nUser-agent: badbot\nDisallow: /`
  assert.equal(robotsAllows(txt, '/events/2026'), false)
  assert.equal(robotsAllows(txt, '/events/public/list'), true)
  assert.equal(robotsAllows(txt, '/shows'), true)
  assert.equal(robotsAllows(txt, '/shows', 'badbot/1.0'), false)
  assert.equal(robotsAllows('User-agent: *\nDisallow:', '/anything'), true)
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$', '/a.pdf'), false)
  assert.equal(robotsAllows('', '/x'), true)
})

test('JSON-LD events are found inside @graph and arrays; bad blocks are skipped', () => {
  const html = `
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Mr. Smalls"},
      {"@type":"MusicEvent","name":"Speedy Ortiz","startDate":"2026-10-24T20:00","performer":[{"name":"Speedy Ortiz"}],"offers":{"url":"https://t.example/1"}}]}</script>
    <script type="application/ld+json">[{"@type":"Event","name":"Trivia Night","startDate":"2026-10-25"}]</script>
    <script type="application/ld+json">{not json</script>`
  const ev = extractJsonLd(html)
  assert.equal(ev.length, 2)
  assert.deepEqual(ev[0].performers, ['Speedy Ortiz'])
  assert.equal(ev[0].url, 'https://t.example/1')
})

test('htmlToText keeps link URLs and drops scripts', () => {
  const t = htmlToText('<div><h2>Oct 24</h2><a href="/e/1">Speedy Ortiz</a><script>evil()</script> &amp; friends</div>', 'https://v.example/events')
  assert.match(t, /Speedy Ortiz \(https:\/\/v\.example\/e\/1\)/)
  assert.match(t, /& friends/)
  assert.doesNotMatch(t, /evil/)
})

test('composePost stays within 300 graphemes and keeps the link', () => {
  const text = composePost({ title: 'X'.repeat(400), event_date: '2026-10-24', event_time: '8pm', venue: 'Mr. Smalls', url: 'https://t.example/1' })
  assert.ok([...new Intl.Segmenter().segment(text)].length <= 300)
  assert.match(text, /https:\/\/t\.example\/1$/)
  assert.match(composePost({ title: 'Speedy Ortiz', event_date: '2026-10-24', venue: 'Mr. Smalls' }), /📅 Sat, Oct 24\n📍 Mr\. Smalls/)
})

test('verifyAccount accepts domain handles, site links, and exact names; rejects lookalikes', () => {
  const p = (o) => ({ did: 'did:plc:x', handle: 'x.bsky.social', displayName: '', description: '', ...o })
  assert.equal(verifyAccount({ name: 'Pittsburgh City Paper', website: 'https://www.pghcitypaper.com' }, p({ handle: 'pghcitypaper.com' })).verified, true)
  assert.equal(verifyAccount({ name: 'Roxian Theatre', website: 'https://roxian.example' }, p({ description: 'Official. roxian.example' })).verified, true)
  assert.equal(verifyAccount({ name: 'Benedum Center', website: '' }, p({ displayName: 'Benedum Center' })).verified, true)
  assert.equal(verifyAccount({ name: 'Roxian Theatre', website: 'https://roxian.example' }, p({ displayName: 'roxian fan account lol' })).verified, false)
  assert.equal(verifyAccount({ name: 'Spirit Hall', website: '' }, null).verified, false)
})

test('event keys line up across a review and a scrape of the same show', () => {
  const venues = testConfig().region.venues
  assert.equal(
    eventKeyFor({ date: '2026-10-29', venue: 'Roxian Theatre', headliner: 'Periphery' }, venues),
    eventKeyFor({ date: '2026-10-29', venue: 'The Roxian', headliner: 'PERIPHERY' }, venues),
  )
})

test('tool loop runs tools, feeds results back, and returns the final call', async () => {
  const seen = []
  const replies = [
    { tool_calls: [{ function: { name: 'lookup', arguments: '{"q":"benedum"}' } }] },
    { content: 'thinking out loud' }, // no tool call: loop nudges it
    { tool_calls: [{ function: { name: 'submit', arguments: { answer: 42 } } }] },
  ]
  const api = { chat: async ({ messages }) => { seen.push(messages.length); return { message: { role: 'assistant', ...replies.shift() }, usage: { input: 1, output: 1 } } } }
  const out = await runToolLoop({
    api, model: 'm', system: 's', user: 'u', finalTool: 'submit',
    tools: { lookup: { description: '', parameters: {}, run: async ({ q }) => ({ found: q }) }, submit: { description: '', parameters: {}, run: async () => ({}) } },
  })
  assert.deepEqual(out.result, { answer: 42 })
  assert.deepEqual(seen, [2, 4, 6]) // system+user, +assistant+tool, +assistant+nudge
})

test('tool loop forces an answer on the last step', async () => {
  const offered = []
  const api = {
    chat: async ({ tools }) => {
      offered.push(tools.map((t) => t.function.name))
      const name = tools.length === 1 ? 'submit' : 'lookup'
      return { message: { role: 'assistant', tool_calls: [{ function: { name, arguments: { q: 'x', answer: 'partial' } } }] }, usage: { input: 0, output: 0 } }
    },
  }
  const out = await runToolLoop({
    api, model: 'm', system: 's', user: 'u', finalTool: 'submit', maxSteps: 3,
    tools: { lookup: { description: '', parameters: {}, run: async () => ({}) }, submit: { description: '', parameters: {}, run: async () => ({}) } },
  })
  assert.equal(out.result.answer, 'partial')
  assert.deepEqual(offered, [['lookup', 'submit'], ['lookup', 'submit'], ['submit']])
})

test('scrape fetches a shared site once, and skips venues removed from config', { skip }, async () => {
  for (const name of ['Spirit Hall', 'Spirit Lodge', 'Old Removed Venue']) {
    await db.query(`insert into directory (name, kind, events_url, scrape) values ($1, 'venue', 'https://mrsmalls.example/events', true)`, [name])
  }
  const site = fakeSite()
  const config = testConfig({ region: { venues: ['Spirit Hall', 'Spirit Lodge'] } })
  const stats = await scrapeAndPost({ db, bsky: { post: async () => 'x' }, config, log: memoryLogger(), createMessage: extractModel(), fetchImpl: site.fetchImpl, now: NOW, sleep: async () => {} })
  assert.equal(stats.venues, 1)
  assert.equal(site.requests.filter((r) => r.url.endsWith('/events')).length, 1)
  const { rows } = await db.query('select distinct venue from scraped_events')
  assert.deepEqual(rows.map((r) => r.venue), ['Spirit Hall'])
})

// ─── integration ─────────────────────────────────────────────────────────────
let db
beforeEach(async () => { if (!skip) db = await freshDb() })
afterEach(async () => { await db?.end(); db = null })

function fakeBskyForDiscovery() {
  const profiles = {
    'benedumcenter.bsky.social': { did: 'did:plc:benedum', handle: 'benedumcenter.bsky.social', displayName: 'Benedum Center', description: 'Downtown Pittsburgh' },
    'roxianfan.bsky.social': { did: 'did:plc:fan', handle: 'roxianfan.bsky.social', displayName: 'i love the roxian', description: 'not affiliated' },
    'pghcitypaper.com': { did: 'did:plc:citypaper', handle: 'pghcitypaper.com', displayName: 'Pittsburgh City Paper', description: '' },
  }
  const follows = []
  return {
    did: 'did:plc:bot',
    follows,
    searchActors: async (q) => Object.values(profiles).filter((p) => p.displayName.toLowerCase().includes(q.toLowerCase().split(' ')[0])),
    getProfile: async (h) => { if (!profiles[h]) throw new Error('not found'); return { ...profiles[h], following: false } },
    getAuthorFeed: async ({ actor }) => ({
      posts: actor === 'did:plc:benedum' ? [{ record: { createdAt: new Date(NOW - 3 * 864e5).toISOString() } }] : [],
    }),
    follow: async (did) => { follows.push(did); return `at://did:plc:bot/app.bsky.graph.follow/${did}` },
  }
}

/** Plays the model: one Bluesky search, then a canned answer per organization. */
function fakeDiscoveryModel() {
  const answers = {
    'Benedum Center': { bluesky_handle: 'benedumcenter.bsky.social', website: 'https://benedum.example', events_url: 'https://benedum.example/events', confidence: 0.9, evidence: 'name match' },
    'Mr. Smalls': { bluesky_handle: '', website: 'https://mrsmalls.example', events_url: 'https://mrsmalls.example/events', confidence: 0, evidence: 'no account found' },
    'Roxian Theatre': { bluesky_handle: '@roxianfan.bsky.social', website: 'https://roxian.example', events_url: 'https://roxian.example/shows', confidence: 0.8, evidence: 'top search hit' },
    'Pittsburgh City Paper': { bluesky_handle: 'pghcitypaper.com', website: 'https://www.pghcitypaper.com', events_url: '', confidence: 0.95, evidence: 'domain handle' },
  }
  return {
    chat: async ({ messages }) => {
      const org = messages[1].content.match(/Organization: (.+?) \(/)[1]
      const step = messages.filter((m) => m.role === 'tool').length
      const call = step === 0
        ? { function: { name: 'search_bluesky_accounts', arguments: { query: org } } }
        : { function: { name: 'submit_result', arguments: answers[org] } }
      return { message: { role: 'assistant', content: '', tool_calls: [call] }, usage: { input: 10, output: 5 } }
    },
    webSearch: async () => [],
    webFetch: async () => ({}),
  }
}

test('discovery follows verified active accounts and marks the rest for scraping', { skip }, async () => {
  const config = testConfig({
    region: { venues: ['Benedum Center', 'Mr. Smalls', 'Roxian Theatre'] },
    discover: { aggregators: ['Pittsburgh City Paper'] },
    repost: { dry_run: false },
  })
  const bsky = fakeBskyForDiscovery()
  const log = memoryLogger()
  const fetchImpl = async (url) => ({ ok: !url.includes('roxian.example/shows'), status: 200, url })
  const stats = await discoverAll({ db, bsky, ollama: fakeDiscoveryModel(), config, log, fetchImpl })
  assert.equal(stats.checked, 4)

  const rows = Object.fromEntries((await db.query('select * from directory')).rows.map((r) => [r.name, r]))
  // verified + active: followed, not scraped
  assert.equal(rows['Benedum Center'].did, 'did:plc:benedum')
  assert.equal(rows['Benedum Center'].scrape, false)
  // no account: scrape the site
  assert.equal(rows['Mr. Smalls'].did, null)
  assert.equal(rows['Mr. Smalls'].scrape, true)
  // fan account the model wrongly picked: not followed. Its claimed events page
  // 404s, so the bot falls back to scraping the homepage.
  assert.equal(rows['Roxian Theatre'].verified, false)
  assert.equal(rows['Roxian Theatre'].events_url, 'https://roxian.example')
  assert.equal(rows['Roxian Theatre'].scrape, true)
  // aggregator verified by domain handle; aggregators are never scraped
  assert.equal(rows['Pittsburgh City Paper'].did, 'did:plc:citypaper')
  assert.equal(rows['Pittsburgh City Paper'].scrape, false)
  assert.deepEqual(bsky.follows.sort(), ['did:plc:benedum', 'did:plc:citypaper'])

  // second pass within refresh_days: nothing re-checked
  const again = await discoverAll({ db, bsky, ollama: fakeDiscoveryModel(), config, log, fetchImpl })
  assert.equal(again.checked, 0)
  assert.equal(again.skipped_fresh, 4)
})

test('discovery in dry run records would-follow without following', { skip }, async () => {
  const config = testConfig({ region: { venues: ['Benedum Center'] }, discover: { aggregators: [] }, repost: { dry_run: true } })
  const bsky = fakeBskyForDiscovery()
  await discoverAll({ db, bsky, ollama: fakeDiscoveryModel(), config, log: memoryLogger(), fetchImpl: async (url) => ({ ok: true, status: 200, url }) })
  assert.equal(bsky.follows.length, 0)
  const [row] = (await db.query('select follow_dry_run, followed_at from directory')).rows
  assert.equal(row.follow_dry_run, true)
  assert.ok(row.followed_at)
})

function fakeSite({ robots = 'User-agent: *\nDisallow: /admin' } = {}) {
  const requests = []
  const pages = {
    'https://mrsmalls.example/robots.txt': robots,
    'https://mrsmalls.example/events': `<html><script type="application/ld+json">
      [{"@type":"MusicEvent","name":"Speedy Ortiz w/ Dazy","startDate":"2026-10-24T20:00"},
       {"@type":"MusicEvent","name":"Periphery","startDate":"2026-10-29T19:00"}]</script>
      <body><h1>Upcoming</h1><a href="/e/speedy">Speedy Ortiz</a> Sat Oct 24 8pm
      <a href="/e/trivia">Trivia Night</a> Sun Oct 25</body></html>`,
  }
  const fetchImpl = async (url, init) => {
    requests.push({ url, ua: init?.headers?.['user-agent'] })
    const body = pages[url]
    return body == null
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => body }
  }
  return { fetchImpl, requests }
}

const extractModel = (calls = []) => async (body) => {
  calls.push(body)
  return {
    content: [{
      type: 'tool_use', name: 'record_events',
      input: {
        events: [
          { title: 'Speedy Ortiz w/ Dazy', headliner: 'Speedy Ortiz', date: '2026-10-24', time: '8pm', url: '/e/speedy', is_music: true },
          { title: 'Trivia Night', date: '2026-10-25', is_music: false },
          { title: 'Periphery', headliner: 'Periphery', date: '2026-10-29', time: '7pm doors', url: 'javascript:alert(1)', is_music: true },
          { title: 'Old Show', date: '2026-10-01', is_music: true },
          { title: 'No date show', date: '', is_music: true },
          { title: 'Far Future', date: '2026-12-20', is_music: true },
        ],
      },
    }],
  }
}

async function seedScrapeTarget() {
  await db.query(
    `insert into directory (name, kind, events_url, scrape) values ('Mr. Smalls', 'venue', 'https://mrsmalls.example/events', true)`,
  )
}

test('scrape extracts events, skips what was already shared, and posts the rest', { skip }, async () => {
  await seedScrapeTarget()
  // The Periphery show was already reposted from the venue's own post.
  const pKey = eventKeyFor({ date: '2026-10-29', venue: 'Mr. Smalls', headliner: 'Periphery' }, testConfig().region.venues)
  await db.query(`insert into candidates (uri, cid, author_did, text, created_at, text_hash) values ('at://x/p/1','c','did:x','t',now(),'h')`)
  await db.query(`insert into reposts (uri, dry_run, event_key) values ('at://x/p/1', false, $1)`, [pKey])

  const config = testConfig({ repost: { dry_run: false } })
  const posts = []
  const bsky = { post: async (p) => { posts.push(p); return `at://did:plc:bot/app.bsky.feed.post/${posts.length}` } }
  const site = fakeSite()
  const calls = []
  const log = memoryLogger()
  const stats = await scrapeAndPost({ db, bsky, config, log, createMessage: extractModel(calls), fetchImpl: site.fetchImpl, now: NOW, sleep: async () => {} })

  assert.equal(stats.pages_fetched, 1)
  assert.ok(site.requests.every((r) => r.ua.startsWith('celevent-bot/')))
  assert.match(calls[0].messages[0].content, /Structured event data/) // JSON-LD was passed along
  // saved: Speedy, Trivia (non-music), Periphery, Far Future; not the past or undated ones
  assert.equal(stats.events_new, 4)
  const { rows } = await db.query('select title, url from scraped_events order by event_date')
  assert.equal(rows.find((r) => r.title === 'Periphery').url, null) // javascript: URL dropped
  assert.equal(rows.find((r) => r.title.startsWith('Speedy')).url, 'https://mrsmalls.example/e/speedy')

  // posted: only Speedy (Trivia isn't music, Periphery already reposted, Far Future outside window)
  assert.equal(posts.length, 1)
  assert.match(posts[0].text, /🎶 Speedy Ortiz w\/ Dazy\n📅 Sat, Oct 24 · 8pm\n📍 Mr\. Smalls\n\nhttps:\/\/mrsmalls\.example\/e\/speedy/)
  assert.equal(posts[0].link.uri, 'https://mrsmalls.example/e/speedy')

  // next run inside the interval: no refetch, no duplicate post
  const again = await scrapeAndPost({ db, bsky, config, log, createMessage: extractModel(), fetchImpl: site.fetchImpl, now: new Date(NOW.getTime() + 36e5), sleep: async () => {} })
  assert.equal(again.pages_fetched, 0)
  assert.equal(posts.length, 1)
})

test('scrape honors robots.txt', { skip }, async () => {
  await seedScrapeTarget()
  const site = fakeSite({ robots: 'User-agent: *\nDisallow: /events' })
  const calls = []
  const stats = await scrapeAndPost({ db, bsky: {}, config: testConfig(), log: memoryLogger(), createMessage: extractModel(calls), fetchImpl: site.fetchImpl, now: NOW, sleep: async () => {} })
  assert.equal(stats.robots_blocked, 1)
  assert.equal(stats.pages_fetched, 0)
  assert.equal(calls.length, 0)
  assert.equal(site.requests.filter((r) => r.url.endsWith('/events')).length, 0)
})

test('a repost is skipped when the bot already posted that event from the website', { skip }, async () => {
  await seedScrapeTarget()
  const config = testConfig({ repost: { dry_run: false } })
  const bsky = { post: async () => 'at://did:plc:bot/app.bsky.feed.post/1', repost: async () => { throw new Error('should not repost') } }
  await scrapeAndPost({ db, bsky, config, log: memoryLogger(), createMessage: extractModel(), fetchImpl: fakeSite().fetchImpl, now: NOW, sleep: async () => {} })

  // Later someone posts about the same Speedy Ortiz show and the review accepts it.
  const { repostAccepted } = await import('../src/repost.js')
  await db.query(`insert into candidates (uri, cid, author_did, text, created_at, text_hash, status) values ('at://y/p/2','c','did:y','t',now(),'h2','reviewed')`)
  const key = eventKeyFor({ date: '2026-10-24', venue: 'Mr Smalls Theatre', headliner: 'Speedy Ortiz' }, config.region.venues)
  await db.query(`insert into reviews (uri, is_event, is_local, confidence, event_date, event_key, accepted, model) values ('at://y/p/2', true, true, 0.9, '2026-10-24', $1, true, 'm')`, [key])
  const { stats } = await repostAccepted({ db, bsky, config, log: memoryLogger(), today: '2026-10-21', now: NOW })
  assert.equal(stats.reposted, 0)
})
