/**
 * Electron-side hosted-callback OAuth against cloudos-auth (https://auth.pdx.software).
 *
 * Flow:
 *   1. App generates a random nonce, POSTs to /api/auth/sign-in/social to get the
 *      Google authorization URL, opens it in the system browser.
 *   2. User signs in with Google. cloudos-auth sets the .pdx.software session cookie.
 *   3. better-auth redirects to /native/post-signin, which mints a one-time code
 *      and 302s the browser to chatvas-api /auth/callback?nonce=...&code=...&state=... .
 *   4. chatvas-api stashes { code } in KV keyed by nonce (short TTL) and renders
 *      a success page.
 *   5. App polls chatvas-api /auth/poll?nonce=... every ~1.5s, receives { code, state }
 *      on the first tick after the browser lands, then POSTs to /native/exchange
 *      to swap the code for the bearer token.
 *   6. Bearer token is stored via secrets.js (safeStorage-encrypted) and used for
 *      future authenticated calls as `Authorization: Bearer <token>`.
 */

import { ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { getSecret, setSecret } from './secrets.js'

const AUTH_BASE = 'https://auth.pdx.software'
const CHATVAS_API = 'https://chatvas-api.lazee.workers.dev'
const TOKEN_KEY = '__AUTH_SESSION_TOKEN__'
const VALID_PROVIDERS = Object.freeze(new Set(['google', 'github', 'apple', 'linkedin']))
const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 1500

let mainWindowGetter = null

function send(channel, data) {
  try {
    const win = mainWindowGetter?.()
    if (win && !win.isDestroyed()) win.webContents.send(channel, data)
  } catch (e) {
    console.warn('[auth] failed to notify renderer:', e?.message)
  }
}

function getAuthToken() {
  return getSecret(TOKEN_KEY)
}

async function authFetch(path, init = {}) {
  const token = getAuthToken()
  const headers = new Headers(init.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'application/json')
  return fetch(`${AUTH_BASE}${path}`, { ...init, headers })
}

async function getSession() {
  if (!getAuthToken()) return null
  try {
    const res = await authFetch('/api/auth/get-session')
    if (!res.ok) {
      if (res.status === 401) setSecret(TOKEN_KEY, null)
      return null
    }
    const data = await res.json()
    return data?.user ? { user: data.user, session: data.session } : null
  } catch (e) {
    console.warn('[auth] getSession failed:', e?.message)
    return null
  }
}

async function signOut() {
  const token = getAuthToken()
  if (token) {
    try { await authFetch('/api/auth/sign-out', { method: 'POST' }) }
    catch (e) { console.warn('[auth] sign-out request failed, clearing local token:', e?.message) }
  }
  setSecret(TOKEN_KEY, null)
  send('auth:changed', { user: null })
  return { ok: true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll chatvas-api /auth/poll until the browser flow deposits a code or the
 * overall timeout expires. Returns the one-time code from cloudos-auth.
 */
async function pollForHandoff(nonce, expectedState) {
  const deadline = Date.now() + SIGNIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CHATVAS_API}/auth/poll?nonce=${encodeURIComponent(nonce)}`, {
        headers: { Accept: 'application/json' }
      })
      if (res.ok) {
        const data = await res.json()
        if (data?.code) {
          if (expectedState && data.state !== expectedState) {
            throw new Error('state mismatch')
          }
          return data.code
        }
      }
    } catch (e) {
      console.warn('[auth] poll tick failed:', e?.message)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('auth timeout')
}

async function signIn(provider) {
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider: ${provider}`)
  }

  const state = randomBytes(16).toString('hex')
  const nonce = randomBytes(16).toString('hex')

  // Where the browser lands once post-signin mints a code.
  const hostedCallback = `${CHATVAS_API}/auth/callback?nonce=${encodeURIComponent(nonce)}`
  const dest = `${AUTH_BASE}/native/post-signin?dest=${encodeURIComponent(hostedCallback)}&state=${encodeURIComponent(state)}`

  // Open the system browser directly to the sign-in kickoff on the auth
  // Worker. /native/start POSTs to better-auth's sign-in/social internally and
  // responds with a 302 + Set-Cookie, so the browser captures the CSRF state
  // cookie AND follows the redirect to Google in one hop. Doing the POST
  // ourselves from Node fetch would strand the state cookie.
  const startUrl = `${AUTH_BASE}/native/start?provider=${encodeURIComponent(provider)}&callbackURL=${encodeURIComponent(dest)}`
  await shell.openExternal(startUrl)

  const code = await pollForHandoff(nonce, state)

  const exchRes = await fetch(`${AUTH_BASE}/native/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
  if (!exchRes.ok) {
    const t = await exchRes.text().catch(() => exchRes.statusText)
    throw new Error(`exchange failed: ${exchRes.status} ${t}`)
  }
  const { token } = await exchRes.json()
  if (!token) throw new Error('exchange returned no token')

  setSecret(TOKEN_KEY, token)

  const session = await getSession()
  send('auth:changed', { user: session?.user ?? null })
  return session
}

export function registerAuthIpc({ getMainWindow }) {
  mainWindowGetter = getMainWindow

  ipcMain.handle('auth:signIn', async (_e, provider) => {
    try {
      const session = await signIn(provider)
      return { ok: true, user: session?.user ?? null }
    } catch (e) {
      console.warn('[auth] signIn failed:', e?.message)
      return { ok: false, error: e?.message || 'sign-in failed' }
    }
  })

  ipcMain.handle('auth:getSession', async () => {
    const session = await getSession()
    return session?.user ? { user: session.user } : null
  })

  ipcMain.handle('auth:signOut', async () => {
    return signOut()
  })
}

// Re-export for other main-process modules that need to hit the Worker
// with the user's session (e.g., per-user config fetches).
export { getAuthToken, authFetch, getSession as readSession }
