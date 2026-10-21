import { createServer } from 'node:http'
import { kvGet, kvSet, kvDel } from './store.js'

/**
 * AT Protocol OAuth for the bot account.
 *
 * The flow (handled by @atproto/oauth-client-node):
 *   1. Resolve handle -> DID -> PDS -> its authorization server metadata.
 *   2. Pushed Authorization Request with PKCE, signed by a fresh DPoP key.
 *   3. User approves in the browser; the auth server redirects to our
 *      loopback callback with a code.
 *   4. Code is exchanged for DPoP-bound access + refresh tokens. Every later
 *      request carries a DPoP proof JWT signed by that same key, so a leaked
 *      access token is useless without the private key.
 *
 * State (PKCE verifier, DPoP key) and sessions (tokens + DPoP private JWK) are
 * stored in Postgres via the kv table, so the cron job can restore the session
 * and the library refreshes tokens transparently.
 *
 * This uses a *loopback* client (client_id http://localhost?...). No hosted
 * metadata needed, which is right for a single-operator bot, but auth servers
 * give loopback clients shorter-lived refresh tokens. For a long-running
 * production deployment, host client-metadata.json + jwks.json and switch to a
 * confidential client (token_endpoint_auth_method: private_key_jwt); the
 * stores below don't change.
 */

const STATE_PREFIX = 'oauth:state:'
const SESSION_PREFIX = 'oauth:session:'
const DEFAULT_DID_KEY = 'oauth:default_did'

export function pgStores(db) {
  const store = (prefix) => ({
    async set(key, value) { await kvSet(db, prefix + key, value) },
    async get(key) { return (await kvGet(db, prefix + key)) ?? undefined },
    async del(key) { await kvDel(db, prefix + key) },
  })
  return { stateStore: store(STATE_PREFIX), sessionStore: store(SESSION_PREFIX) }
}

/**
 * Postgres advisory lock so two processes (say, a cron run overlapping a
 * manual run) never refresh the same token at once. Refresh tokens are
 * single-use; a race revokes the session.
 */
export function pgLock(db) {
  return async (name, fn) => {
    // Blocks until any other holder finishes, rather than racing it.
    await db.query('select pg_advisory_lock(hashtext($1))', [name])
    try {
      return await fn()
    } finally {
      await db.query('select pg_advisory_unlock(hashtext($1))', [name])
    }
  }
}

export async function createOAuthClient({ db, config }) {
  const { NodeOAuthClient, buildAtprotoLoopbackClientMetadata } =
    await import('@atproto/oauth-client-node')
  const { oauthScope, oauthPort } = config.env
  const redirectUri = `http://127.0.0.1:${oauthPort}/callback`

  return new NodeOAuthClient({
    clientMetadata: buildAtprotoLoopbackClientMetadata({
      scope: oauthScope,
      redirect_uris: [redirectUri],
    }),
    ...pgStores(db),
    // Advisory locks need one connection held across lock/unlock; with a pool
    // that isn't guaranteed, so this is only used when db exposes connect().
    requestLock: db.connect ? pooledLock(db) : undefined,
  })
}

function pooledLock(pool) {
  return async (name, fn) => {
    const conn = await pool.connect()
    try {
      return await pgLock(conn)(name, fn)
    } finally {
      conn.release()
    }
  }
}

/**
 * Interactive one-time login: prints an authorize URL, waits for the loopback
 * callback, stores the session, and remembers the DID as the bot account.
 */
export async function interactiveLogin({ db, config, log, handle }) {
  const client = await createOAuthClient({ db, config })
  const port = config.env.oauthPort

  const done = new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      try {
        const { session } = await client.callback(url.searchParams)
        await kvSet(db, DEFAULT_DID_KEY, session.did)
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('celevent-bot is signed in. You can close this tab.')
        server.close()
        resolve(session.did)
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(`Sign-in failed: ${err.message}`)
        server.close()
        reject(err)
      }
    })
    server.listen(port, '127.0.0.1')
  })

  const url = await client.authorize(handle, { scope: config.env.oauthScope })
  log.info('open this URL to authorize the bot account', { url: url.toString() })
  process.stderr.write(`\nOpen this URL in a browser signed in as ${handle}:\n\n  ${url}\n\n`)

  const did = await done
  log.info('oauth login complete', { did })
  return did
}

/** Restore the stored OAuth session for the bot and build an Agent on it. */
export async function restoreOAuthAgent({ db, config, log }) {
  const did = config.env.oauthDid ?? (await kvGet(db, DEFAULT_DID_KEY))
  if (!did) {
    throw new Error(
      'No OAuth session. Run `npm run login -- <handle>` once, or set BSKY_APP_PASSWORD to use app-password auth.',
    )
  }
  const client = await createOAuthClient({ db, config })
  const session = await client.restore(did) // refreshes the access token if it expired
  const { Agent } = await import('@atproto/api')
  log.info('bsky session restored', { did, mode: 'oauth' })
  return { agent: new Agent(session), did }
}
