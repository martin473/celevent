-- directory       one row per venue/aggregator: its Bluesky account (if any),
--                 official site and events page, as found by discovery
-- scraped_events  events extracted from venue websites
-- own_posts       original posts the bot wrote for scraped events

create table if not exists directory (
  name           text primary key,
  kind           text not null check (kind in ('venue', 'aggregator')),
  did            text,
  handle         text,
  website        text,
  events_url     text,
  confidence     real,
  verified       boolean not null default false,
  verify_note    text,
  evidence       text,
  last_post_at   timestamptz,
  followed_at    timestamptz,
  follow_dry_run boolean,
  scrape         boolean not null default false,
  discovered_at  timestamptz not null default now(),
  model          text
);

create table if not exists scraped_events (
  event_key    text primary key,
  title        text not null,
  headliner    text,
  venue        text not null,
  event_date   date not null,
  event_time   text,
  url          text,
  source_url   text not null,
  is_music     boolean not null default true,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create index if not exists scraped_events_date_idx on scraped_events (event_date);

create table if not exists own_posts (
  event_key   text not null references scraped_events (event_key) on delete cascade,
  dry_run     boolean not null,
  post_uri    text,
  text        text not null,
  posted_at   timestamptz not null default now(),
  primary key (event_key, dry_run)
);
