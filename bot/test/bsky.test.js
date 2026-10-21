import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapAgent } from '../src/bsky.js'

let AtpAgent
try { ({ AtpAgent } = await import('@atproto/api')) } catch {}

/**
 * Checks the thin client sends the right XRPC calls, using the real
 * @atproto/api agent against a mocked fetch.
 */
test('wrapAgent maps to the expected XRPC endpoints', { skip: !AtpAgent && '@atproto/api not installed' }, async () => {
  const calls = []
  const pv = (uri) => ({
    uri, cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
    author: { did: 'did:plc:v', handle: 'v.test' },
    record: { $type: 'app.bsky.feed.post', text: 'hi', createdAt: '2026-10-21T00:00:00.000Z' },
    indexedAt: '2026-10-21T00:00:00.000Z',
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    const body = req.method === 'POST' ? await req.json() : undefined
    calls.push({ method: req.method, nsid: url.pathname.replace('/xrpc/', ''), params: Object.fromEntries(url.searchParams), body })
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
    switch (url.pathname) {
      case '/xrpc/com.atproto.server.createSession':
        return json({ did: 'did:plc:bot', handle: 'bot.test', accessJwt: 'a', refreshJwt: 'r', active: true })
      case '/xrpc/app.bsky.feed.searchPosts':
        return json({ posts: [pv('at://did:plc:x/app.bsky.feed.post/1')], cursor: 'c2' })
      case '/xrpc/app.bsky.feed.getAuthorFeed':
        return json({ feed: [{ post: pv('at://did:plc:y/app.bsky.feed.post/2') }] })
      case '/xrpc/app.bsky.graph.getFollows':
        return json({ subject: { did: 'did:plc:bot', handle: 'bot.test' }, follows: [{ did: 'did:plc:v', handle: 'v.test' }] })
      case '/xrpc/com.atproto.repo.createRecord':
        return json({ uri: 'at://did:plc:bot/app.bsky.feed.repost/abc', cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm' })
      default:
        return new Response('{}', { status: 404 })
    }
  }
  try {
    const agent = new AtpAgent({ service: 'https://pds.test' })
    await agent.login({ identifier: 'bot.test', password: 'pw' })
    const c = wrapAgent(agent, agent.did)

    const s = await c.searchPosts({ q: '"Mr. Smalls"', since: '2026-10-20T00:00:00.000Z', cursor: undefined })
    assert.equal(s.cursor, 'c2')
    const a = await c.getAuthorFeed({ actor: 'did:plc:v' })
    assert.equal(a.posts[0].uri, 'at://did:plc:y/app.bsky.feed.post/2')
    const f = await c.getFollows({ actor: 'did:plc:bot' })
    assert.equal(f.follows[0].did, 'did:plc:v')
    const r = await c.repost('at://x/app.bsky.feed.post/1', 'bafyx')
    assert.equal(r, 'at://did:plc:bot/app.bsky.feed.repost/abc')

    const byNsid = Object.fromEntries(calls.map((x) => [x.nsid, x]))
    assert.deepEqual(byNsid['app.bsky.feed.searchPosts'].params, {
      q: '"Mr. Smalls"', since: '2026-10-20T00:00:00.000Z', sort: 'latest', limit: '100',
    })
    assert.equal(byNsid['app.bsky.feed.getAuthorFeed'].params.filter, 'posts_and_author_threads')
    const rec = byNsid['com.atproto.repo.createRecord'].body
    assert.equal(rec.collection, 'app.bsky.feed.repost')
    assert.deepEqual(rec.record.subject, { uri: 'at://x/app.bsky.feed.post/1', cid: 'bafyx' })
  } finally {
    globalThis.fetch = realFetch
  }
})
