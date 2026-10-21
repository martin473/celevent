import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { feedConfig, feedUri, didDocument, feedSkeleton } from './feed.js'
import { health, metricsText } from './health.js'
import { kvGet, kvSet } from './store.js'
import { errMsg } from './log.js'

/**
 * The bot's public HTTP surface:
 *
 *   /.well-known/did.json                     did:web document for the feed generator
 *   /xrpc/app.bsky.feed.describeFeedGenerator feed list
 *   /xrpc/app.bsky.feed.getFeedSkeleton       "Pittsburgh shows this week"
 *   /oauth/client-metadata.json, /oauth/jwks.json   confidential OAuth client
 *   /oauth/login?token=ADMIN_TOKEN, /oauth/callback one-time sign-in for the bot
 *   /healthz, /metrics                        health check and Prometheus metrics
 *
 * `getOAuthClient` is injected so tests don't need the OAuth library.
 */
export function createHandler({ db, config, log, getOAuthClient }) {
  const fc = feedConfig(config)

  const routes = {
    'GET /': async () => text(200, 'celevent-bot\n'),

    'GET /healthz': async () => {
      const h = await health(db, config)
      return json(h.healthy ? 200 : 503, h)
    },

    'GET /metrics': async () => ({
      status: 200, headers: { 'content-type': 'text/plain; version=0.0.4' }, body: await metricsText(db, config),
    }),

    'GET /.well-known/did.json': async () => (fc ? json(200, didDocument(fc)) : notFound()),

    'GET /xrpc/app.bsky.feed.describeFeedGenerator': async () => {
      if (!fc) return notFound()
      const uri = await feedUri(db, fc)
      return json(200, { did: fc.serviceDid, feeds: uri ? [{ uri }] : [] })
    },

    'GET /xrpc/app.bsky.feed.getFeedSkeleton': async (url) => {
      if (!fc) return notFound()
      const want = await feedUri(db, fc)
      if (url.searchParams.get('feed') !== want) {
        return json(400, { error: 'UnsupportedAlgorithm', message: 'Unknown feed' })
      }
      return json(200, await feedSkeleton(db, {
        config, limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor'),
      }))
    },

    'GET /oauth/client-metadata.json': async () => {
      const client = await getOAuthClient?.()
      return client ? json(200, client.clientMetadata) : notFound()
    },

    'GET /oauth/jwks.json': async () => {
      const client = await getOAuthClient?.()
      return client ? json(200, client.jwks) : notFound()
    },

    // Starting a sign-in is gated by ADMIN_TOKEN, and the callback only accepts
    // the bot's own account, so nobody else can attach their session here.
    'GET /oauth/login': async (url) => {
      const client = await getOAuthClient?.()
      if (!client) return notFound()
      if (!tokenMatches(url.searchParams.get('token'), config.env.adminToken)) return text(403, 'forbidden\n')
      const handle = url.searchParams.get('handle') ?? config.env.identifier
      const redirect = await client.authorize(handle, { scope: config.env.oauthScope })
      return { status: 302, headers: { location: redirect.toString() }, body: '' }
    },

    'GET /oauth/callback': async (url) => {
      const client = await getOAuthClient?.()
      if (!client) return notFound()
      const { session } = await client.callback(url.searchParams)
      const expected = config.env.oauthDid ?? (await kvGet(db, 'bot:did'))
        ?? (config.env.identifier ? await resolveHandleDid(config.env.identifier).catch(() => null) : null)
      if (!expected || session.did !== expected) {
        await client.revoke?.(session.did).catch(() => {})
        log.warn('oauth callback for unexpected account', { did: session.did, expected })
        return text(403, 'That is not the bot account.\n')
      }
      await kvSet(db, 'oauth:default_did', session.did)
      await kvSet(db, 'bot:did', session.did)
      log.info('oauth login complete', { did: session.did })
      return text(200, 'celevent-bot is signed in with OAuth. You can close this tab.\n')
    },
  }

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const route = routes[`${req.method} ${url.pathname}`]
    let out
    try {
      out = route ? await route(url) : notFound()
    } catch (err) {
      log.error('http error', { path: url.pathname, error: errMsg(err) })
      out = json(500, { error: 'InternalServerError' })
    }
    res.writeHead(out.status, { 'access-control-allow-origin': '*', ...out.headers })
    res.end(out.body)
  }
}

export function startServer({ db, config, log, getOAuthClient, port = config.env.port }) {
  const server = createServer(createHandler({ db, config, log, getOAuthClient }))
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      log.info('http listening', { port: server.address().port, public_url: config.env.publicUrl ?? null })
      resolve(server)
    })
  })
}

async function resolveHandleDid(handle) {
  const res = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`)
  if (!res.ok) throw new Error(`resolveHandle ${res.status}`)
  return (await res.json()).did
}

function tokenMatches(given, expected) {
  if (!given || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const text = (status, body) => ({ status, headers: { 'content-type': 'text/plain' }, body })
const notFound = () => json(404, { error: 'NotFound' })
