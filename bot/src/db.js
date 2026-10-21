import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { BOT_ROOT } from './config.js'

/**
 * The rest of the bot only needs `query(sql, params) -> { rows }` and `end()`,
 * which is exactly node-postgres' Pool interface. Tests swap in a different
 * implementation with the same shape.
 */
export async function connect(databaseUrl) {
  const { default: pg } = await import('pg')
  // Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Dates.
  pg.types.setTypeParser(1082, (v) => v)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  return pool
}

export async function migrate(db, { dir = path.join(BOT_ROOT, 'sql'), log } = {}) {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`)
  const { rows } = await db.query('select name from schema_migrations')
  const applied = new Set(rows.map((r) => r.name))

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (applied.has(file)) continue
    await db.query(readFileSync(path.join(dir, file), 'utf8'))
    await db.query('insert into schema_migrations (name) values ($1)', [file])
    log?.info('migration applied', { file })
  }
}
