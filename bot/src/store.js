/**
 * All SQL lives here. Each function takes the db (anything with
 * `query(sql, params)`), so the pipeline never builds SQL itself.
 */

// ─── kv: cursors, sessions, OAuth state ─────────────────────────────────────
export async function kvGet(db, key) {
  const { rows } = await db.query('select value from kv where key = $1', [key])
  return rows[0]?.value
}

export async function kvSet(db, key, value) {
  await db.query(
    `insert into kv (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  )
}

export async function kvDel(db, key) {
  await db.query('delete from kv where key = $1', [key])
}

// ─── candidates ─────────────────────────────────────────────────────────────

/**
 * Insert a candidate, or if the URI is already known just record the extra
 * source that saw it. Returns true when the row is new.
 */
export async function upsertCandidate(db, c) {
  const { rows } = await db.query(
    `insert into candidates
       (uri, cid, author_did, author_handle, text, created_at, sources,
        text_hash, prefilter_score, status, skip_reason, labels)
     values ($1, $2, $3, $4, $5, $6, array[$7::text], $8, $9, $10, $11, $12::text[])
     on conflict (uri) do update set
       sources = case when $7::text = any(candidates.sources) then candidates.sources
                      else array_append(candidates.sources, $7::text) end,
       author_handle = coalesce(candidates.author_handle, excluded.author_handle)
     returning (xmax = 0) as inserted`,
    [
      c.uri, c.cid, c.authorDid, c.authorHandle ?? null, c.text, c.createdAt,
      c.source, c.textHash, c.score, c.status, c.skipReason ?? null, c.labels ?? [],
    ],
  )
  return rows[0]?.inserted === true
}

/**
 * Pending candidates oldest-first. A pending post whose normalized text
 * matches one that was already reviewed or queued earlier is marked duplicate
 * here instead of costing another LLM call (cross-posts, copy-pasted flyers).
 */
export async function markTextDuplicates(db) {
  const { rows } = await db.query(
    `update candidates c set status = 'duplicate', skip_reason = 'same text as ' || d.uri
     from (
       select distinct on (c2.uri) c2.uri as dup_uri, o.uri
       from candidates c2
       join candidates o
         on o.text_hash = c2.text_hash and o.uri <> c2.uri
        and (o.status = 'reviewed'
             or (o.status = 'pending' and (o.first_seen_at, o.uri) < (c2.first_seen_at, c2.uri)))
       where c2.status = 'pending'
       order by c2.uri, o.first_seen_at
     ) d
     where c.uri = d.dup_uri
     returning c.uri`,
  )
  return rows.length
}

export async function pendingCandidates(db, { limit, exclude = [] }) {
  const { rows } = await db.query(
    `select uri, cid, author_did, author_handle, text, created_at, first_seen_at, sources
     from candidates where status = 'pending' and not (uri = any($2::text[]))
     order by created_at asc limit $1`,
    [limit, exclude],
  )
  return rows
}

export async function bumpReviewAttempt(db, uris, { maxAttempts }) {
  if (!uris.length) return
  await db.query(
    `update candidates set
       review_attempts = review_attempts + 1,
       status = case when review_attempts + 1 >= $2 then 'error' else status end
     where uri = any($1::text[])`,
    [uris, maxAttempts],
  )
}

// ─── reviews ────────────────────────────────────────────────────────────────
export async function saveReview(db, r) {
  await db.query(
    `insert into reviews
       (uri, is_event, is_local, confidence, title, headliner, venue,
        event_date, event_time, event_key, reason, accepted, reject_code, model)
     values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14)
     on conflict (uri) do nothing`,
    [
      r.uri, r.isEvent, r.isLocal, r.confidence, r.title ?? null, r.headliner ?? null,
      r.venue ?? null, r.eventDate ?? null, r.eventTime ?? null, r.eventKey ?? null,
      r.reason ?? null, r.accepted, r.rejectCode ?? null, r.model,
    ],
  )
  await db.query(`update candidates set status = 'reviewed' where uri = $1`, [r.uri])
}

// ─── reposts ────────────────────────────────────────────────────────────────

/**
 * Accepted, not yet reposted, event still upcoming, and no other post about
 * the same event (same date + venue + headliner) already reposted.
 */
export async function repostQueue(db, { today, limit, dryRun }) {
  const { rows } = await db.query(
    `select r.uri, c.cid, r.event_key, r.title, r.venue, r.event_date::text as event_date,
            c.created_at, c.first_seen_at
     from reviews r
     join candidates c on c.uri = r.uri
     where r.accepted
       and r.event_date >= $1::date
       and not exists (select 1 from reposts p where p.uri = r.uri and p.dry_run = $3)
       and (r.event_key is null
            or not exists (select 1 from reposts p
                           where p.event_key = r.event_key and p.dry_run = $3))
     order by r.event_date asc, c.created_at asc
     limit $2`,
    [today, limit, dryRun],
  )
  return rows
}

export async function repostsSince(db, since, { dryRun }) {
  const { rows } = await db.query(
    'select count(*)::int as n from reposts where reposted_at >= $1 and dry_run = $2',
    [since, dryRun],
  )
  return rows[0].n
}

export async function saveRepost(db, { uri, repostUri, eventKey, dryRun }) {
  const { rows } = await db.query(
    `insert into reposts (uri, repost_uri, event_key, dry_run) values ($1, $2, $3, $4)
     on conflict (uri, dry_run) do nothing returning uri`,
    [uri, repostUri ?? null, eventKey ?? null, dryRun],
  )
  return rows.length === 1
}

// ─── runs ───────────────────────────────────────────────────────────────────
export async function startRun(db, kind) {
  const { rows } = await db.query('insert into runs (kind) values ($1) returning id', [kind])
  return rows[0].id
}

export async function finishRun(db, id, { ok, stats }) {
  await db.query(
    'update runs set finished_at = now(), ok = $2, stats = $3::jsonb where id = $1',
    [id, ok, JSON.stringify(stats)],
  )
}

export async function recentRuns(db, limit = 10) {
  const { rows } = await db.query(
    `select id, kind, started_at, finished_at, ok, stats from runs
     order by id desc limit $1`,
    [limit],
  )
  return rows
}

/** Accepted events that haven't happened yet, soonest first. */
export async function upcomingAccepted(db, { today, limit = 30 }) {
  const { rows } = await db.query(
    `select r.uri, r.title, r.venue, r.event_date::text as event_date, r.confidence,
            c.author_handle,
            exists (select 1 from reposts p where p.uri = r.uri and not p.dry_run) as reposted,
            exists (select 1 from reposts p where p.uri = r.uri and p.dry_run) as dry_reposted
     from reviews r join candidates c on c.uri = r.uri
     where r.accepted and r.event_date >= $1::date
     order by r.event_date, r.reviewed_at limit $2`,
    [today, limit],
  )
  return rows
}

export async function rejectCounts(db, { since }) {
  const { rows } = await db.query(
    `select reject_code, count(*)::int as n from reviews
     where not accepted and reviewed_at >= $1 group by reject_code order by n desc`,
    [since],
  )
  return rows
}

export async function recentDecisions(db, limit = 20) {
  const { rows } = await db.query(
    `select r.uri, r.accepted, r.reject_code, r.confidence, r.title, r.venue,
            r.event_date::text as event_date, r.reason, c.author_handle,
            (p.uri is not null) as reposted
     from reviews r join candidates c on c.uri = r.uri
     left join reposts p on p.uri = r.uri and not p.dry_run
     order by r.reviewed_at desc limit $1`,
    [limit],
  )
  return rows
}
