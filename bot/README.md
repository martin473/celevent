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
cp .env.example .env          # add OLLAMA_API_KEY (or ANTHROPIC_API_KEY) and the bot's app password
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

## Finding venue accounts and scraping venue websites

```bash
npm run discover            # look up every venue and aggregator (skips ones checked < 30 days ago)
npm run discover -- Benedum # just one
npm run discover -- --force # re-check everything
npm run directory           # what it found, and scraped shows
npm run scrape              # scrape now instead of waiting for the next run
```

**Discovery** (needs `OLLAMA_API_KEY`). For each venue in `region.venues` and
each aggregator in `discover.aggregators` (City Paper, WYEP, ...), the model
runs as an agent with three tools: Bluesky account search, Ollama web search,
and Ollama web fetch. It reports the official Bluesky handle (or none), the
official website, and the events page.

The model's answer is checked in code before anything is followed: the handle
must be the organization's domain, or the profile must link the official site,
or the display name/handle must match the name. Fan accounts and lookalikes
fail that check. Verified accounts are followed, which makes them a source for
the normal repost pipeline. `npm run loop` repeats discovery once a day for
entries older than `discover.refresh_days`.

**Scraping.** A venue is scraped when it has an events page but no verified
account, or its account hasn't posted in `discover.active_within_days`. The
bot reads the page's schema.org event data (JSON-LD) and visible text, the LLM
turns that into dated events, and upcoming music shows within
`scrape.post_within_days` are posted from the bot account:

```
🎶 Speedy Ortiz w/ Dazy
📅 Sat, Oct 24 · 8pm
📍 Mr. Smalls

https://venue-site/event-page
```

Posts carry the facts and a link card back to the venue; descriptions aren't
copied. robots.txt is honored, requests send a `celevent-bot` User-Agent, pages
are fetched at most every `scrape.interval_hours`, with a pause between sites.
The same event is never shared twice: a show that was reposted from the
venue's own post isn't posted again, and vice versa (matched on date + venue +
headliner, with venue names normalized). Following and posting both obey
`DRY_RUN`. Add pages discovery misses with `scrape.extra_pages`:
`[{ "venue": "Mr. Smalls", "url": "https://..." }]`.

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
5. **Review.** Pending posts go to the LLM in batches of 20, and the reply is
   always structured JSON: a forced `record_decisions` tool call with Claude,
   or the same schema as Ollama's `format` (structured outputs). It extracts title, headliner, venue, and date and says whether
   it's a local upcoming event. The accept/reject rules (confidence threshold,
   date window) are applied in code, not in the prompt, so they're testable.
   Post text is wrapped and escaped, and the model is told it's untrusted data,
   to blunt prompt injection from strangers' posts.
6. **Repost.** Accepted events, soonest first, within the caps. A post is
   skipped when another post about the **same event** (same date, venue, and
   headliner) was already reposted, so the venue and the band announcing the
   same show produce one repost, not two.

## LLM backend: Ollama or Claude

- **Ollama Cloud**: set `OLLAMA_API_KEY` (from ollama.com/settings/keys). Requests
  go to `https://ollama.com/api/chat`. Default model `gpt-oss:20b`; try
  `CELEVENT_MODEL=gpt-oss:120b` if decisions look shaky.
- **Local Ollama**: leave the key empty, set `OLLAMA_HOST=http://localhost:11434`,
  and `ollama pull` a model that handles JSON well (e.g. `qwen3:8b`), then set
  `CELEVENT_MODEL` to it.
- **Claude**: set `ANTHROPIC_API_KEY` (default `claude-haiku-5-5`).

`LLM_PROVIDER=ollama|anthropic` forces one. Both backends feed the same review
loop and the same accept rules, so switching models only changes the
extraction quality, which `npm run status` lets you check during dry runs.

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

## Running it for real: deploy, custom feed, OAuth, alerts

`npm run serve` is production mode: one process that runs the batch loop
(every 20 min, discovery daily, scraping every 12 h), optionally the
Jetstream collector, and an HTTP server with:

| Path | What |
|---|---|
| `/.well-known/did.json` | `did:web` document for the feed generator |
| `/xrpc/app.bsky.feed.getFeedSkeleton` | the "Pittsburgh Shows This Week" custom feed |
| `/oauth/client-metadata.json`, `/oauth/jwks.json` | confidential OAuth client |
| `/oauth/login?token=…`, `/oauth/callback` | one-time OAuth sign-in for the bot account |
| `/healthz` | 200 if the last run succeeded within 3 intervals, else 503 |
| `/metrics` | Prometheus metrics (ingest lag, run failures, reposts, posts) |

### Deploy to Fly.io

```bash
brew install flyctl && fly auth signup        # or fly auth login
cd bot
fly launch --no-deploy --copy-config          # pick an app name; edit `app` in fly.toml to match
fly postgres create                           # or use any Postgres (Neon, Supabase) and its URL
fly postgres attach <pg-app-name>             # sets DATABASE_URL
fly secrets set \
  PUBLIC_URL=https://<app>.fly.dev \
  OLLAMA_API_KEY=... \
  BSKY_IDENTIFIER=pittsburghevents.bsky.social \
  BSKY_APP_PASSWORD=... \
  ADMIN_TOKEN=$(openssl rand -hex 24) \
  OAUTH_PRIVATE_KEY="$(npm run -s oauth-keygen | sed "s/^OAUTH_PRIVATE_KEY='//; s/'$//")" \
  ALERT_WEBHOOK_URL=https://ntfy.sh/<pick-a-secret-topic>
fly deploy
curl https://<app>.fly.dev/healthz
```

Fly's health check hits `/healthz` and restarts the machine when it keeps
failing. With `FLY_API_TOKEN` (from `fly tokens create deploy`) saved as a
GitHub repo secret, `.github/workflows/bot.yml` deploys `main` after the test
suite passes against Postgres; without it, CI just runs the tests.

### Switch the bot to OAuth (DPoP)

1. Visit `https://<app>.fly.dev/oauth/login?token=<ADMIN_TOKEN>` in a browser
   signed in to the bot's Bluesky account and approve.
2. `fly secrets set BSKY_AUTH=oauth && fly secrets unset BSKY_APP_PASSWORD`

The bot is a confidential client: Bluesky fetches its metadata and public key
from `/oauth/*`, the token request is authenticated with a `private_key_jwt`,
and every API call carries a DPoP proof signed by a per-session key. Starting
sign-in requires `ADMIN_TOKEN`, and the callback rejects (and revokes) any
account other than the bot's.

### Publish the custom feed

```bash
fly ssh console -C "node src/cli.js publish-feed"
```

This writes an `app.bsky.feed.generator` record to the bot's repo pointing at
`did:web:<app>.fly.dev`. Search "Pittsburgh Shows This Week" in Bluesky's feeds
or open the link it prints, and pin it. The feed lists one post per show in
the next 7 days, soonest first: accepted posts from venues/bands/press, plus
the bot's own posts for scraped shows.

### Alerts

Set `ALERT_WEBHOOK_URL` to a Discord or Slack webhook, or to
`https://ntfy.sh/<topic>` and install the ntfy app for phone push. After each
run the bot alerts on: a failed run, LLM errors, half or more sources failing,
ingest lag p50 over 2 h, or a failed scrape. Each alert repeats at most hourly,
and a "healthy again" message follows recovery. Thresholds are in `alerts` in
`config.json`.

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
    cli.js            migrate | login | run | loop | serve | stream | discover |
                      scrape | directory | publish-feed | oauth-keygen | status
    pipeline.js       one run: collect -> review -> repost, writes run stats
    collect.js        followed accounts + searches, cursors, pagination
    jetstream.js      live firehose collector with checkpointed cursor
    normalize.js      post views / Jetstream records -> candidates
    prefilter.js      cheap event + location scoring
    review.js         prompt, schema, Ollama + Claude clients, decision rules
    repost.js         caps, dry run, same-event dedupe
    discover.js       agent that finds venue accounts + events pages; verification; follows
    scrape.js         robots.txt, JSON-LD + text extraction, posts for scraped shows
    ollama.js         Ollama chat with tools, web search, web fetch
    server.js         HTTP: feed generator, OAuth client hosting, /healthz, /metrics
    feed.js           did:web document and getFeedSkeleton query
    health.js         health check, Prometheus metrics, webhook alerts
    bsky.js           thin Bluesky client + app-password auth
    oauth.js          OAuth/DPoP login, Postgres stores, advisory lock
    store.js          all SQL
    log.js            JSON logs and spans
```
