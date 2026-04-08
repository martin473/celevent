import { useState, useEffect } from 'react'
import { publishEvent, generateCalendarId } from '../lib/atproto'

const CAL_ID_KEY = 'calevent_cal_id'

function getOrCreateCalId() {
  let id = localStorage.getItem(CAL_ID_KEY)
  if (!id) {
    id = generateCalendarId()
    localStorage.setItem(CAL_ID_KEY, id)
  }
  return id
}

export default function PostEvent({ session }) {
  const [calendarId] = useState(getOrCreateCalId)
  const [title, setTitle]       = useState('')
  const [description, setDesc]  = useState('')
  const [start, setStart]       = useState('')
  const [end, setEnd]           = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState(null) // { uri } | { error }

  async function handleSubmit(e) {
    e.preventDefault()
    setResult(null)

    if (end && start && new Date(end) < new Date(start)) {
      setResult({ error: 'End time must be after start time.' })
      return
    }

    setLoading(true)
    try {
      const { uri } = await publishEvent({
        title: title.trim(),
        description: description.trim(),
        start: new Date(start).toISOString(),
        end:   end ? new Date(end).toISOString() : '',
        calendarId,
      })
      setResult({ uri })
      setTitle('')
      setDesc('')
      setStart('')
      setEnd('')
    } catch (err) {
      setResult({ error: err?.message ?? 'Failed to publish. Try again.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h2 className="section-title">Post an event</h2>
      <p className="section-sub">
        Published as a post on your Bluesky account. Anyone using calevent
        who follows you will see it in their reader.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 20 }}>
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label>Title</label>
              <input
                type="text"
                placeholder="What's the event?"
                value={title}
                onChange={e => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label>Description</label>
              <textarea
                placeholder="Details, location, links…"
                value={description}
                onChange={e => setDesc(e.target.value)}
              />
            </div>

            <div className="row2">
              <div className="field">
                <label>Start</label>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={e => setStart(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label>End</label>
                <input
                  type="datetime-local"
                  value={end}
                  onChange={e => setEnd(e.target.value)}
                />
              </div>
            </div>

            {result?.error && (
              <div className="alert alert-danger" style={{ marginBottom: 14 }}>
                {result.error}
              </div>
            )}

            {result?.uri && (
              <div className="alert alert-success" style={{ marginBottom: 14 }}>
                Published! Your event is live on Bluesky.
              </div>
            )}

            <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
              {loading ? <><span className="spinner" /> Publishing…</> : 'Publish event'}
            </button>
          </form>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 10 }}>
              Your calendar ID
            </p>
            <div className="cal-id">{calendarId}</div>
            <p style={{ fontSize: 12, color: 'var(--ink3)', marginTop: 10, lineHeight: 1.5 }}>
              This ID is embedded in every event you post. Share it so others
              can filter just your calendar in the reader.
            </p>
          </div>

          <div className="card">
            <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 10 }}>
              Posting as
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {session.avatar && (
                <div className="avatar" style={{ width: 32, height: 32 }}>
                  <img src={session.avatar} alt="" />
                </div>
              )}
              <div>
                <p style={{ fontSize: 14, fontWeight: 500 }}>{session.displayName || session.handle}</p>
                <p style={{ fontSize: 12, color: 'var(--ink3)', fontFamily: 'var(--mono)' }}>@{session.handle}</p>
              </div>
            </div>
          </div>

          <div className="card">
            <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 10 }}>
              How it works
            </p>
            <ol style={{ fontSize: 12, color: 'var(--ink2)', lineHeight: 1.7, paddingLeft: 16 }}>
              <li>Events are posted as regular Bluesky posts</li>
              <li>Tagged <span style={{ fontFamily: 'var(--mono)' }}>#calevent</span> so they're searchable</li>
              <li>Your calendar ID links all your events together</li>
              <li>The reader finds events from people you follow</li>
            </ol>
          </div>
        </div>
      </div>

      {result?.uri && (
        <div style={{ marginTop: 20 }} className="card">
          <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink3)', marginBottom: 8 }}>
            AT-URI
          </p>
          <div className="cal-id">{result.uri}</div>
        </div>
      )}
    </div>
  )
}
