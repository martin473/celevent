# celevent-bot

A Bluesky repost bot for local shows. It watches a set of accounts and
searches, has an LLM decide which posts are real upcoming Pittsburgh show
announcements, and reposts those from the bot account. Following the bot
becomes a "Pittsburgh shows" feed with no custom feed generator to host.

It extends calevent's idea (events are just Bluesky posts) from posts that
follow the `#calevent` format to the messy, free-text way venues, bands, and
promoters actually announce shows.

```
 followed accounts ─┐
 searches ──────────┼─► normalize ─► prefilter ─► candidates ─► dedupe ─► LLM review ─► repost
 Jetstream (live) ──┘   (text +      (cheap,      (Postgres,    (text     (batched,      (caps,
                         link card,   no LLM)      by AT-URI)    hash)     tool-forced    dry-run,
                         alt text)                                         JSON)          same-event
                                                                                          dedupe)
```

## Quick start

```bash
cd bot
docker compose up -d          # Postgres 16
cp .env.example .env          # add ANTHROPIC_API_KEY and the bot's app password
npm install
npm run migrate
npm run run-once              # one batch; DRY_RUN=1 by default
npm run status                # what it saw, what it decided, and why
```

Watch a few dry runs with `npm run status`. When the accept/reject calls look
right, set `DRY_RUN=0`.

To keep it running: `npm run loop` (every `loop.interval_minutes`), or cron
`npm run run-once`. Optionally run `npm run stream` alongside it to pick up
posts live from Jetstream instead of waiting for the next search.

## Choosing what it watches

Everything is in `config.json`:

- **`sources.follow_bot_follows`**: the bot reads the feeds of every account
  it follows. Manage sources by following venues, promoters, and bands from the
  bot's account in the Bluesky app. Posts from these accounts are "trusted": they
  don't need to mention Pittsburgh to reach the LLM.
- **`sources.accounts`**: extra handles or DIDs to read without following.
- **`sources.searches`**: search queries; `search_venue_names` adds a quoted
  search for every venue in `region.venues`.
- **`region`**: location words and venue names, used by the prefilter and
  given to the model as context.
- **`review`**: model, batch size, `min_confidence`, and `window_days` (how
  far ahead an event can be and still get reposted).
- **`repost`**: `max_per_run`, `max_per_day`, `dry_run`.

## How a run works

1. **Collect.** For each followed account, `getAuthorFeed` back to the newest
   post seen last time. For each search, `searchPosts` with `since` = last run
   minus 15 minutes. Cursors live in the `kv` table. A source that errors is
   logged and counted; the others continue.
2. **Normalize.** Show details are often in a link card (ticket page title),
   image alt text (the flyer), or a quoted post, so those are folded into the
   text the prefilter and model see.
3. **Prefilter.** Regexes for event signals (dates, times, "doors", "tix",
   "w/") and location signals (neighborhoods, venues). This exists to save LLM
   calls: it's tuned to let junk through rather than drop real shows.
4. **Dedupe.** Candidates are keyed by AT-URI, so a post found by three sources
   is stored once. Posts whose normalized text matches one already queued
   (copy-pasted flyers, cross-posts) are marked `duplicate` before review.
5. **Review.** Pending posts go to Claude in batches of 20. The model must
   answer through a `record_decisions` tool call, so the output is always
   structured. It extracts title, headliner, venue, and date and says whether
   it's a local upcoming event. The accept/reject rules (confidence threshold,
   date window) are applied in code, not in the prompt, so they're testable.
   Post text is wrapped and escaped, and the model is told it's untrusted data,
   to blunt prompt injection from strangers' posts.
6. **Repost.** Accepted events, soonest first, within the caps. A post is
   skipped when another post about the **same event** (same date, venue, and
   headliner) was already reposted, so the venue and the band announcing the
   same show produce one repost, not two.

## Auth: app password or OAuth with DPoP

**App password** (`BSKY_IDENTIFIER` + `BSKY_APP_PASSWORD`) is the simplest
for a cron job. The session is cached in Postgres and resumed, because calling
`createSession` every run gets rate limited.

**OAuth** (`BSKY_AUTH=oauth`, then `npm run login -- yourbot.bsky.social` once)
uses `@atproto/oauth-client-node`:

- resolves handle → DID → PDS → authorization server metadata
- Pushed Authorization Request with PKCE
- tokens are **DPoP-bound**: each request carries a proof JWT signed by a
  per-session key, so a stolen access token is useless without that key
- state, tokens, and the DPoP private JWK are stored in Postgres; later runs
  `restore()` the session and the library refreshes tokens transparently
- token refresh runs under a Postgres advisory lock, because refresh tokens are
  single-use and two overlapping runs racing a refresh would revoke the session

It's configured as a loopback client (`http://localhost?...` client_id), which
needs nothing hosted but gets shorter-lived refresh tokens. For production,
host `client-metadata.json` and `jwks.json` and switch to a confidential client
(`private_key_jwt`); the stores and lock don't change. `BSKY_OAUTH_SCOPE`
defaults to `atproto transition:generic`; narrowing it to granular repo/rpc
scopes is a good next step.

## Operating it

Logs are one JSON object per line, with a `trace_id` per run and `span` lines
for every stage and source with durations:

```bash
npm run run-once | jq 'select(.msg=="span") | {span, ms, source, error}'
npm run run-once | jq 'select(.msg=="review decision") | {accepted, reject, title, reason}'
```

Each run writes a row to `runs` with counts and two health numbers:

- **`ingest_lag_sec`** (p50/p95/max): post created → collected. If it climbs,
  sources are failing or the schedule is too sparse.
- **`post_to_repost_sec`**: post created → reposted, the end-to-end latency.

The Jetstream collector checkpoints its cursor every 10 seconds and logs
throughput and lag (`now - event time`). On restart it rewinds 5 seconds and
resumes, so nothing is missed. A climbing `lag_ms_p50` means the process is
falling behind the firehose.

Failure handling: LLM 429/5xx retries with backoff; if the LLM is down the run
still reposts already-approved posts and retries review next run; a post the
model keeps skipping is parked as `error` after `review.max_attempts`; deleted
or blocked posts leave the repost queue instead of failing forever.

## Tests

```bash
TEST_DATABASE_URL=postgres://celevent:celevent@localhost:5432/celevent npm test
```

Unit tests cover the prefilter, normalization, decision rules, prompt escaping,
and API retry. Integration tests run the whole pipeline against a real
Postgres (a fresh database per test) with a fake Bluesky client and a fake
model: cross-source dedupe, text duplicates, same-event dedupe, caps, dry-run →
live, missing decisions, an LLM outage, a failing source, and Jetstream
cursor resume. Without `TEST_DATABASE_URL` the Postgres tests are skipped.

## Files

```
bot/
  config.json         sources, region, thresholds
  sql/001_init.sql    schema
  src/
    cli.js            migrate | login | run | loop | stream | status
    pipeline.js       one run: collect -> review -> repost, writes run stats
    collect.js        followed accounts + searches, cursors, pagination
    jetstream.js      live firehose collector with checkpointed cursor
    normalize.js      post views / Jetstream records -> candidates
    prefilter.js      cheap event + location scoring
    review.js         prompt, tool schema, Messages API client, decision rules
    repost.js         caps, dry run, same-event dedupe
    bsky.js           thin Bluesky client + app-password auth
    oauth.js          OAuth/DPoP login, Postgres stores, advisory lock
    store.js          all SQL
    log.js            JSON logs and spans
```
