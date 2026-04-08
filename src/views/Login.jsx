import { useState } from 'react'
import { login } from '../lib/atproto'

export default function Login({ onLogin }) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword]     = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const session = await login(identifier.trim(), password)
      onLogin(session)
    } catch (err) {
      setError(err?.message ?? 'Login failed. Check your handle and app password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <h1 className="login-title">cal<span>event</span></h1>
        <p className="login-sub">
          Sign in with your Bluesky account to post and read federated events.
        </p>

        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label>Handle or email</label>
              <input
                type="text"
                placeholder="you.bsky.social"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                autoComplete="username"
                required
              />
            </div>

            <div className="field" style={{ marginBottom: 20 }}>
              <label>App password</label>
              <input
                type="password"
                placeholder="xxxx-xxxx-xxxx-xxxx"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <p style={{ fontSize: 11, color: 'var(--ink3)', marginTop: 5 }}>
                Create one at Settings → App Passwords in Bluesky.
                Never use your main password.
              </p>
            </div>

            {error && (
              <div className="alert alert-danger" style={{ marginBottom: 16 }}>
                {error}
              </div>
            )}

            <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
