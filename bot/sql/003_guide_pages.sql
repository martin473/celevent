-- Event guides and listings published by aggregators (City Paper's monthly
-- guide, "things to do this weekend" roundups). Added by hand in config or
-- picked up automatically when a followed aggregator posts a link to one.
create table if not exists guide_pages (
  url           text primary key,
  source        text not null,
  title         text,
  first_seen    timestamptz not null default now(),
  last_scraped  timestamptz,
  events_found  int
);
