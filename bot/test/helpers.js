import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { migrate } from '../src/db.js'

/**
 * Integration tests run against a real Postgres. Point TEST_DATABASE_URL at a
 * server where you can create databases (docker compose up gives you one at
 * postgres://celevent:celevent@localhost:5432/celevent). Each test file gets
 * its own throwaway database.
 *
 * If the `pg` package is installed it's used; otherwise queries go through
 * the psql CLI, so the suite also runs where npm installs aren't possible.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

export async function freshDb() {
  if (!TEST_DATABASE_URL) return null
  const name = `celevent_test_${randomBytes(4).toString('hex')}`
  const admin = await open(TEST_DATABASE_URL)
  await admin.query(`create database ${name}`)
  await admin.end()

  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  const db = await open(url.toString())
  await migrate(db)

  const end = db.end.bind(db)
  db.end = async () => {
    await end()
    const a = await open(TEST_DATABASE_URL)
    await a.query(`drop database if exists ${name} with (force)`)
    await a.end()
  }
  return db
}

async function open(url) {
  try {
    const { default: pg } = await import('pg')
    pg.types.setTypeParser(1082, (v) => v)
    return new pg.Pool({ connectionString: url, max: 2 })
  } catch {
    return psqlDb(url)
  }
}

/** Minimal `query(sql, params) -> { rows }` over the psql CLI. Test-only. */
export function psqlDb(url) {
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL'
    if (Array.isArray(v)) {
      v = '{' + v.map((x) => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
    } else if (v instanceof Date) v = v.toISOString()
    else if (typeof v === 'object') v = JSON.stringify(v)
    return "'" + String(v).replace(/'/g, "''") + "'"
  }
  return {
    async query(sql, params = []) {
      // Single pass, so a parameter value containing "$2" is never re-substituted.
      const text = sql.replace(/\$(\d+)/g, (m, n) => (n <= params.length ? lit(params[n - 1]) : m))
      const returnsRows = /^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text)
      const script = returnsRows
        ? `with q as (${text.replace(/;\s*$/, '')}) select coalesce(json_agg(q), '[]') from q;`
        : text
      const res = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-f', '-'], {
        input: script, encoding: 'utf8',
      })
      if (res.status !== 0) throw new Error(res.stderr.trim() || 'psql failed')
      if (!returnsRows) return { rows: [] }
      return { rows: JSON.parse(res.stdout.trim() || '[]') }
    },
    async end() {},
  }
}

export function testConfig(overrides = {}) {
  const cfg = loadConfig({ env: { BSKY_APP_PASSWORD: 'x', DRY_RUN: '0' } })
  cfg.sources.searches = ['pittsburgh show']
  cfg.sources.search_venue_names = false
  return deepMerge(cfg, overrides)
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k]) deepMerge(a[k], v)
    else a[k] = v
  }
  return a
}

// ─── fakes ──────────────────────────────────────────────────────────────────
let seq = 0
export function postView({ text, handle = 'someone.bsky.social', did, createdAt, embed, labels, reply }) {
  seq++
  const authorDid = did ?? `did:plc:${handle.replace(/\W/g, '')}`
  return {
    uri: `at://${authorDid}/app.bsky.feed.post/3k${seq.toString(36)}`,
    cid: `bafy${seq}`,
    author: { did: authorDid, handle },
    record: { $type: 'app.bsky.feed.post', text, createdAt: createdAt.toISOString(), ...(reply ? { reply } : {}) },
    embed,
    labels: labels?.map((val) => ({ val })) ?? [],
    indexedAt: createdAt.toISOString(),
  }
}

export function fakeBsky({ did = 'did:plc:bot', follows = [], authorFeeds = {}, search = {} } = {}) {
  const calls = { reposts: [], search: [], author: [] }
  return {
    did,
    calls,
    async resolveHandle(h) { return `did:plc:${h.replace(/\W/g, '')}` },
    async getFollows() { return { follows, cursor: undefined } },
    async getAuthorFeed({ actor }) {
      calls.author.push(actor)
      return { posts: authorFeeds[actor] ?? [], cursor: undefined }
    },
    async searchPosts({ q, since }) {
      calls.search.push({ q, since })
      return { posts: search[q] ?? [], cursor: undefined }
    },
    async repost(uri, cid) {
      calls.reposts.push({ uri, cid })
      return `at://${did}/app.bsky.feed.repost/${calls.reposts.length}`
    },
  }
}

/**
 * Fake Messages API. `judge(text)` returns the decision fields for a post;
 * the fake parses our own prompt format back into posts, like the model would.
 */
export function fakeLlm(judge) {
  const requests = []
  const createMessage = async (body) => {
    requests.push(body)
    const posts = [...body.messages[0].content.matchAll(/<post id="(p\d+)"[^>]*>\n([\s\S]*?)\n<\/post>/g)]
    const decisions = posts.map(([, id, text]) => ({ id, ...judge(text) })).filter((d) => !d.omit)
    return {
      content: [{ type: 'tool_use', name: 'record_decisions', input: { decisions } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    }
  }
  createMessage.requests = requests
  return createMessage
}
