import { useState, useEffect, useCallback } from 'react'
import { fetchFollowingEvents, fetchUserEvents, fmtDate, fmtRange } from '../lib/atproto'

function EventCard({ event }) {
  const d = event.start
  const month = d.toLocaleDateString([], { month: 'short' }).toUpperCase()
  const day   = d.getDate()

  return (
    <div className="event-card">
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div className="event-date-badge">
          <span className="month">{month}</span>
          <span className="day">{day}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="event-title">{event.title}</p>
          <p className="event-meta">{fmtRange(event.start, event.end)}</p>
          {event.description && (
            <p className="event-desc">{event.description}</p>
          )}
          <div className="author-row">
            {event.author?.avatar && (
              <div className="avatar">
                <img src={event.author.avatar} alt="" />
              </div>
            )}
            <span className="author-handle">
              @{event.author?.handle}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <span className="pill pill-accent">
                {event.calendarId?.slice(0, 14)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function groupByMonth(events) {
  const groups = {}
  for (const ev of events) {
    const key = ev.start.toLocaleDateString([], { month: 'long', year: 'numeric' })
    if (!groups[key]) groups[key] = []
    groups[key].push(ev)
  }
  return groups
}

export default function Reader() {
  const [events, setEvents]       = useState([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)
  const [filterCal, setFilterCal] = useState('')
  const [lookupHandle, setLookup] = useState('')
  const [mode, setMode]           = useState('following') // 'following' | 'user'
  const [loaded, setLoaded]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let evs
      if (mode === 'user' && lookupHandle.trim()) {
        evs = await fetchUserEvents(lookupHandle.trim())
      } else {
        evs = await fetchFollowingEvents({
          calendarId: filterCal.trim() || null,
        })
      }
      setEvents(evs)
      setLoaded(true)
    } catch (err) {
      setError(err?.message ?? 'Failed to load events.')
    } finally {
      setLoading(false)
    }
  }, [mode, lookupHandle, filterCal])

  // Auto-load following feed on mount
  useEffect(() => {
    if (mode === 'following') load()
  }, [])

  const filtered = filterCal.trim()
    ? events.filter(ev => ev.calendarId === filterCal.trim())
    : events

  const upcoming = filtered.filter(ev => ev.start >= new Date())
  const past     = filtered.filter(ev => ev.start < new Date())

  const upcomingGroups = groupByMonth(upcoming)
  const pastGroups     = groupByMonth(past)

  return (
    <div>
      <h2 className="section-title">Event reader</h2>
      <p className="section-sub">
        Events posted by people you follow on Bluesky, filtered from their feeds.
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 2, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
            {['following', 'user'].map(m => (
              <button
                key={m}
                className={`nav-tab${mode === m ? ' active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m === 'following' ? 'From following' : 'By handle'}
              </button>
            ))}
          </div>

          {mode === 'user' && (
            <div style={{ flex: 1, minWidth: 160 }}>
              <input
                type="text"
                placeholder="handle.bsky.social"
                value={lookupHandle}
                onChange={e => setLookup(e.target.value)}
                style={{ background: 'var(--surface2)', border: '0.5px solid var(--border-md)', borderRadius: 8, padding: '7px 12px', fontSize: 14, color: 'var(--ink)', width: '100%', outline: 'none' }}
              />
            </div>
          )}

          <div style={{ flex: 1, minWidth: 180 }}>
            <input
              type="text"
              placeholder="Filter by calendar ID…"
              value={filterCal}
              onChange={e => setFilterCal(e.target.value)}
              style={{ background: 'var(--surface2)', border: '0.5px solid var(--border-md)', borderRadius: 8, padding: '7px 12px', fontSize: 14, color: 'var(--ink)', width: '100%', outline: 'none', fontFamily: 'var(--mono)' }}
            />
          </div>

          <button
            className="btn btn-primary"
            onClick={load}
            disabled={loading}
          >
            {loading ? <span className="spinner" /> : 'Load'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>
      )}

      {!loaded && !loading && (
        <div className="empty-state">
          <div className="empty-icon">📅</div>
          <p>Hit Load to fetch events from people you follow.</p>
        </div>
      )}

      {loaded && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <p>No events found.</p>
          <p style={{ marginTop: 4 }}>
            {filterCal
              ? 'No events match that calendar ID.'
              : 'People you follow haven\'t posted any #calevent posts yet.'}
          </p>
        </div>
      )}

      {upcoming.length > 0 && (
        <section>
          {Object.entries(upcomingGroups).map(([month, evs]) => (
            <div key={month}>
              <div className="month-group">{month}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {evs.map(ev => <EventCard key={ev.uri} event={ev} />)}
              </div>
            </div>
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <div className="month-group" style={{ color: 'var(--ink3)', opacity: .6 }}>Past events</div>
          <div style={{ opacity: .65, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {past.slice(-10).map(ev => <EventCard key={ev.uri} event={ev} />)}
          </div>
        </section>
      )}
    </div>
  )
}
