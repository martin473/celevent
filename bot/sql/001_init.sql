-- celevent-bot schema
--
-- candidates  every post any source surfaced, deduped by AT-URI
-- reviews     one LLM verdict per candidate
-- reposts     what the bot actually reposted (or would have, in dry-run)
-- runs        per-run stats: counts, stage timings, ingest lag
-- kv          cursors, cached sessions, OAuth state

create table if not exists candidates (
  uri             text primary key,
  cid             text not null,
  author_did      text not null,
  author_handle   text,
  text            text not null,
  created_at      timestamptz not null,
  first_seen_at   timestamptz not null default now(),
  sources         text[] not null default '{}',
  text_hash       text not null,
  prefilter_score real not null default 0,
  status          text not null default 'pending'
                  check (status in ('pending', 'skipped', 'duplicate', 'reviewed', 'error')),
  skip_reason     text,
  review_attempts int not null default 0,
  labels          text[] not null default '{}'
);

create index if not exists candidates_status_idx on candidates (status, created_at);
create index if not exists candidates_text_hash_idx on candidates (text_hash);

create table if not exists reviews (
  uri          text primary key references candidates (uri) on delete cascade,
  is_event     boolean not null,
  is_local     boolean not null,
  confidence   real not null,
  title        text,
  headliner    text,
  venue        text,
  event_date   date,
  event_time   text,
  event_key    text,
  reason       text,
  accepted     boolean not null,
  reject_code  text,
  model        text not null,
  reviewed_at  timestamptz not null default now()
);

create index if not exists reviews_accepted_idx on reviews (accepted, event_date);
create index if not exists reviews_event_key_idx on reviews (event_key) where accepted;

-- dry_run is part of the key so dry-run history never blocks the real repost
-- once you switch DRY_RUN off.
create table if not exists reposts (
  uri          text not null references candidates (uri) on delete cascade,
  dry_run      boolean not null,
  repost_uri   text,
  event_key    text,
  reposted_at  timestamptz not null default now(),
  primary key (uri, dry_run)
);

create index if not exists reposts_event_key_idx on reposts (event_key);

create table if not exists runs (
  id           bigserial primary key,
  kind         text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  stats        jsonb not null default '{}'
);

create table if not exists kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
