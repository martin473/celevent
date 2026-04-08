import { useState, useEffect } from 'react'
import { agent, restoreSession, logout } from './lib/atproto'
import Login from './views/Login'
import PostEvent from './views/PostEvent'
import Reader from './views/Reader'

export default function App() {
  const [session, setSession] = useState(null)
  const [view, setView]       = useState('reader') // 'reader' | 'post'
  const [restoring, setRestoring] = useState(true)

  useEffect(() => {
    restoreSession().then(ok => {
      if (ok) setSession(agent.session)
      setRestoring(false)
    })
  }, [])

  function handleLogin(s) {
    setSession(s)
  }

  function handleLogout() {
    logout()
    setSession(null)
  }

  if (restoring) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="spinner" />
      </div>
    )
  }

  if (!session) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-brand">cal<span>event</span></span>

        <div className="topbar-right">
          <nav className="nav-tabs">
            <button
              className={`nav-tab${view === 'reader' ? ' active' : ''}`}
              onClick={() => setView('reader')}
            >
              Reader
            </button>
            <button
              className={`nav-tab${view === 'post' ? ' active' : ''}`}
              onClick={() => setView('post')}
            >
              Post event
            </button>
          </nav>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {session.avatar && (
              <div className="avatar" style={{ width: 28, height: 28 }}>
                <img src={session.avatar} alt="" />
              </div>
            )}
            <button className="btn btn-sm" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        {view === 'reader' && <Reader />}
        {view === 'post'   && <PostEvent session={session} />}
      </main>
    </div>
  )
}
