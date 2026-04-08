import { BskyAgent } from '@atproto/api'

// ─── Agent singleton ───────────────────────────────────────────────────────────
export const agent = new BskyAgent({ service: 'https://bsky.social' })

// ─── Session persistence ───────────────────────────────────────────────────────
const SESSION_KEY = 'calevent_session'

export async function restoreSession() {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return false
  try {
    const session = JSON.parse(raw)
    await agent.resumeSession(session)
    return true
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return false
  }
}

export async function login(identifier, password) {
  const { data } = await agent.login({ identifier, password })
  localStorage.setItem(SESSION_KEY, JSON.stringify(data))
  return data
}

export function logout() {
  localStorage.removeItem(SESSION_KEY)
}

// ─── Event format ──────────────────────────────────────────────────────────────
//
// Every event is a regular app.bsky.feed.post. The body follows a strict
// parseable structure so any reader can reconstruct the fields.
//
// Wire format (exact):
//
//   📅 #calevent
//
//   TITLE: <title>
//   START: <ISO 8601>
//   END:   <ISO 8601>
//
//   <description>
//
// The #calevent facet is a real Bluesky hashtag so it shows up in search.
// The NAMESPACE line carries the calendar UUID so multiple calendars can coexist.

export const HASHTAG = 'calevent'
export const MARKER  = `#${HASHTAG}`

export function formatEventPost({ title, description, start, end, calendarId }) {
  const lines = [
    `📅 ${MARKER}`,
    ``,
    `TITLE: ${title}`,
    `START: ${start}`,
    `END:   ${end}`,
    `CAL:   ${calendarId}`,
  ]
  if (description.trim()) {
    lines.push(``, description.trim())
  }
  return lines.join('\n')
}

export function parseEventPost(post) {
  const text = post.record?.text ?? ''
  if (!text.includes(MARKER)) return null

  const get = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return match ? match[1].trim() : null
  }

  const title       = get('TITLE')
  const start       = get('START')
  const end         = get('END')
  const calendarId  = get('CAL')

  if (!title || !start) return null

  // Description = everything after the blank line following END/CAL
  const descMatch = text.match(/(?:CAL:.*\n\n)([\s\S]*)$/)
  const description = descMatch ? descMatch[1].trim() : ''

  return {
    uri:         post.uri,
    cid:         post.cid,
    author:      post.author,
    title,
    start:       new Date(start),
    end:         end ? new Date(end) : null,
    calendarId,
    description,
    indexedAt:   new Date(post.indexedAt),
  }
}

// ─── Post event ───────────────────────────────────────────────────────────────
export async function publishEvent({ title, description, start, end, calendarId }) {
  const text = formatEventPost({ title, description, start, end, calendarId })

  // Build the hashtag facet so Bluesky indexes #calevent properly
  const tagStart = text.indexOf(MARKER)
  const tagEnd   = tagStart + MARKER.length

  const record = {
    $type:     'app.bsky.feed.post',
    text,
    facets: [
      {
        index:    { byteStart: tagStart, byteEnd: tagEnd },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: HASHTAG }],
      },
    ],
    createdAt: new Date().toISOString(),
  }

  return agent.post(record)
}

// ─── Fetch + filter events from following ────────────────────────────────────
export async function fetchFollowingEvents({ calendarId = null, limit = 100 } = {}) {
  const events = []
  let cursor   = undefined
  let calls    = 0

  // Walk the timeline up to 3 pages (300 posts) looking for events
  while (calls < 3) {
    const { data } = await agent.getTimeline({ limit: 100, cursor })
    calls++

    for (const item of data.feed) {
      const ev = parseEventPost(item.post)
      if (!ev) continue
      if (calendarId && ev.calendarId !== calendarId) continue
      events.push(ev)
      if (events.length >= limit) break
    }

    if (!data.cursor || events.length >= limit) break
    cursor = data.cursor
  }

  // Sort ascending by start date
  return events.sort((a, b) => a.start - b.start)
}

// ─── Fetch events from a single user ─────────────────────────────────────────
export async function fetchUserEvents(handle) {
  const { data: profile } = await agent.getProfile({ actor: handle })
  const events = []
  let cursor = undefined

  while (true) {
    const { data } = await agent.getAuthorFeed({
      actor:  profile.did,
      limit:  100,
      cursor,
    })

    for (const item of data.feed) {
      const ev = parseEventPost(item.post)
      if (ev) events.push(ev)
    }

    if (!data.cursor) break
    cursor = data.cursor
  }

  return events.sort((a, b) => a.start - b.start)
}

// ─── Misc utils ───────────────────────────────────────────────────────────────
export function generateCalendarId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return 'cal_' + Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')
}

export function fmtDate(d) {
  if (!d) return ''
  return d.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', year:'numeric' })
}

export function fmtTime(d) {
  if (!d) return ''
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
}

export function fmtRange(start, end) {
  if (!start) return ''
  const sDate = fmtDate(start)
  const sTime = fmtTime(start)
  if (!end) return `${sDate} at ${sTime}`
  const eDate = fmtDate(end)
  const eTime = fmtTime(end)
  if (sDate === eDate) return `${sDate} · ${sTime} – ${eTime}`
  return `${sDate} ${sTime} – ${eDate} ${eTime}`
}
