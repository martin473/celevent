import { kvGet, kvSet, kvDel } from './store.js'

/**
 * The pipeline talks to Bluesky only through this small surface, so tests can
 * hand it a fake and the auth mechanism (app password vs OAuth/DPoP) stays
 * invisible to everything else:
 *
 *   did, resolveHandle, getFollows, getAuthorFeed, searchPosts, repost
 */
export function wrapAgent(agent, did) {
  return {
    did,
    async resolveHandle(handle) {
      const { data } = await agent.com.atproto.identity.resolveHandle({ handle })
      return data.did
    },
    async getFollows({ actor, cursor }) {
      const { data } = await agent.app.bsky.graph.getFollows({ actor, cursor, limit: 100 })
      return { follows: data.follows, cursor: data.cursor }
    },
    async getAuthorFeed({ actor, cursor }) {
      const { data } = await agent.app.bsky.feed.getAuthorFeed({
        actor, cursor, limit: 100, filter: 'posts_and_author_threads',
      })
      return { posts: data.feed.map((item) => item.post), cursor: data.cursor }
    },
    async searchPosts({ q, since, cursor }) {
      const { data } = await agent.app.bsky.feed.searchPosts({
        q, since, cursor, sort: 'latest', limit: 100,
      })
      return { posts: data.posts, cursor: data.cursor }
    },
    async repost(uri, cid) {
      const res = await agent.repost(uri, cid)
      return res.uri
    },
  }
}

/** Build an authenticated client for the bot account from env config. */
export async function connectBluesky({ db, config, log }) {
  const env = config.env
  if (env.authMode === 'oauth') {
    const { restoreOAuthAgent } = await import('./oauth.js')
    const { agent, did } = await restoreOAuthAgent({ db, config, log })
    return wrapAgent(agent, did)
  }
  const { agent, did } = await appPasswordAgent({ db, env, log })
  return wrapAgent(agent, did)
}

/**
 * App-password login with the session cached in Postgres. Re-running
 * createSession on every cron tick gets rate limited quickly, so we resume
 * the stored session and let the agent refresh it.
 */
async function appPasswordAgent({ db, env, log }) {
  if (!env.identifier || !env.appPassword) {
    throw new Error('BSKY_IDENTIFIER and BSKY_APP_PASSWORD are required for app_password auth')
  }
  const { AtpAgent } = await import('@atproto/api')
  const key = `session:app_password:${env.identifier}`

  const agent = new AtpAgent({
    service: env.service,
    persistSession: (evt, session) => {
      const p = session ? kvSet(db, key, session) : kvDel(db, key)
      p.catch((err) => log.warn('session persist failed', { evt, error: err.message }))
    },
  })

  const saved = await kvGet(db, key)
  if (saved) {
    try {
      await agent.resumeSession(saved)
      log.info('bsky session resumed', { did: agent.did, mode: 'app_password' })
      return { agent, did: agent.did }
    } catch (err) {
      log.warn('stored session unusable, logging in again', { error: err.message })
    }
  }
  await agent.login({ identifier: env.identifier, password: env.appPassword })
  log.info('bsky logged in', { did: agent.did, mode: 'app_password' })
  return { agent, did: agent.did }
}
