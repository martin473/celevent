# calevent

A federated event calendar built on Bluesky / AT Protocol.
No backend required. Events live on users' Bluesky accounts.

## Quick start

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and sign in with your Bluesky handle
and an **app password** (Settings → App Passwords in Bluesky).

## How it works

### Posting

Every event is a regular `app.bsky.feed.post` with a structured body:

```
📅 #calevent

TITLE: Design Systems Meetup
START: 2026-05-12T18:00:00.000Z
END:   2026-05-12T20:30:00.000Z
CAL:   cal_a3f9b2c188e14d9a

Join us for talks on tokens and theming.
```

- The `#calevent` hashtag is a real Bluesky facet — it shows up in
  hashtag search and the firehose
- The `CAL:` field is a stable UUID generated once per user and stored
  in localStorage — it ties all your events together without any server
- Posts are written via `agent.post()` — exactly the same as a normal
  Bluesky post, so it shows up on your profile too

### Reading

The reader calls `agent.getTimeline()` (your following feed) and walks
up to 3 pages of posts, filtering for any that contain `#calevent` and
match the parseable structure. It then:

- Sorts events by start date ascending
- Groups them by month
- Separates upcoming from past
- Optionally filters by a specific `CAL:` ID

You can also look up events by a specific handle using
`agent.getAuthorFeed()`.

### Calendar ID sharing

Share your `CAL:` ID with followers and they can paste it into the
reader's filter box to see only your events (not anyone else's
`#calevent` posts).

## File structure

```
src/
  lib/
    atproto.js      # All AT Protocol logic: auth, post, parse, fetch
  views/
    Login.jsx       # App-password login screen
    PostEvent.jsx   # Event creation form
    Reader.jsx      # Following feed reader + filter
  App.jsx           # Root: auth state, nav between views
  main.jsx
  index.css         # Full design system (DM Serif + DM Sans)
```

## Extending

### Add iCal export
```js
// In Reader.jsx, add a download button per event or for the full list
// Use the `ical-generator` npm package
import ical from 'ical-generator'
const cal = ical({ name: 'calevent' })
events.forEach(ev => cal.createEvent({
  start: ev.start,
  end:   ev.end,
  summary: ev.title,
  description: ev.description,
}))
cal.serve(res)  // or cal.toString() for download
```

### Add a shared calendar (multi-poster)
Share a single `CAL:` ID across multiple users. Anyone who posts with
that ID shows up in the same filtered view. No server needed — just
coordinate the ID out of band.

### Add an AppView later
When you want more than 3 pages of history, run a firehose subscriber
(`@atproto/sync`) that filters for `#calevent` posts and indexes them
into Postgres. Your reader can then hit your own `/events` endpoint
instead of `getTimeline`.

```js
import { Firehose } from '@atproto/sync'
const firehose = new Firehose({ service: 'https://bsky.network' })
firehose.on('commit', ({ ops }) => {
  for (const op of ops) {
    if (op.collection === 'app.bsky.feed.post') {
      const ev = parseEventPost({ record: op.record, ...op })
      if (ev) db.insert(ev)
    }
  }
})
```
