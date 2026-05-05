/**
 * Doppler secret management integration.
 *
 * Fetches secrets from Doppler at startup and on demand. Falls back to the
 * local secrets.json store when Doppler is unreachable or unconfigured.
 *
 * Configuration is stored as pseudo-keys in the local secrets store:
 *   __DOPPLER_TOKEN__    — Doppler service token
 *   __DOPPLER_PROJECT__  — project slug (default: "chatvas")
 *   __DOPPLER_CONFIG__   — config slug  (default: "dev")
 */

import { getSecret, setSecret, PSEUDO_KEYS, buildChildEnv, PROVIDER_KEYS } from './secrets.js'

// Register our pseudo-keys
for (const k of ['__DOPPLER_TOKEN__', '__DOPPLER_PROJECT__', '__DOPPLER_CONFIG__']) {
  if (!PSEUDO_KEYS.includes(k)) PSEUDO_KEYS.push(k)
}

const DOPPLER_API = 'https://api.doppler.com/v3/configs/config/secrets/download'

let _cache = null
let _cacheTs = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function isDopplerConfigured() {
  return !!getSecret('__DOPPLER_TOKEN__')
}

export function getDopplerConfig() {
  return {
    token: getSecret('__DOPPLER_TOKEN__') || '',
    project: getSecret('__DOPPLER_PROJECT__') || 'chatvas',
    config: getSecret('__DOPPLER_CONFIG__') || 'dev'
  }
}

export function setDopplerConfig({ token, project, config }) {
  if (token !== undefined) setSecret('__DOPPLER_TOKEN__', token)
  if (project !== undefined) setSecret('__DOPPLER_PROJECT__', project || 'chatvas')
  if (config !== undefined) setSecret('__DOPPLER_CONFIG__', config || 'dev')
  _cache = null // invalidate
}

/**
 * Fetch all secrets from Doppler. Returns a flat { KEY: value } dict.
 * Returns null if Doppler is not configured or unreachable.
 */
export async function fetchDopplerSecrets(force = false) {
  const token = getSecret('__DOPPLER_TOKEN__')
  if (!token) return null

  if (!force && _cache && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return _cache
  }

  const project = getSecret('__DOPPLER_PROJECT__') || 'chatvas'
  const config = getSecret('__DOPPLER_CONFIG__') || 'dev'

  try {
    const url = `${DOPPLER_API}?format=json&project=${encodeURIComponent(project)}&config=${encodeURIComponent(config)}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    })

    if (!res.ok) {
      console.warn(`[doppler] fetch failed: ${res.status} ${res.statusText}`)
      return null
    }

    const data = await res.json()
    _cache = data
    _cacheTs = Date.now()
    return data
  } catch (e) {
    console.warn(`[doppler] fetch error: ${e.message}`)
    return null
  }
}

/**
 * Get a single secret, preferring Doppler if configured, falling back to local.
 */
export async function resolveSecret(name) {
  if (isDopplerConfigured()) {
    const secrets = await fetchDopplerSecrets()
    if (secrets && name in secrets) return secrets[name]
  }
  return getSecret(name)
}

/**
 * Synchronous cache-only lookup. Returns the value from the last Doppler
 * fetch (if cached), else falls back to local. Use for hot-path reads
 * where you can't await.
 */
export function resolveSecretSync(name) {
  if (_cache && name in _cache) return _cache[name]
  return getSecret(name)
}

/**
 * Build a complete child-process env dict with Doppler secrets merged in.
 * Doppler values take precedence over local secrets. This is the async
 * version of secrets.js buildChildEnv.
 */
export async function buildChildEnvWithDoppler(extra = {}) {
  const env = buildChildEnv(extra)

  // Overlay Doppler secrets — they take priority
  if (isDopplerConfigured()) {
    const secrets = await fetchDopplerSecrets()
    if (secrets) {
      for (const k of PROVIDER_KEYS) {
        if (secrets[k]) env[k] = secrets[k]
      }
      // Also pass through any CF/gateway vars Doppler provides
      for (const key of Object.keys(secrets)) {
        if (key.startsWith('CF_') || key.startsWith('CLOUDFLARE_') || key === 'AI_GATEWAY_URL') {
          env[key] = secrets[key]
        }
      }
    }
  }

  return env
}

/**
 * Prefetch Doppler secrets at startup so they're cached for sync access.
 * Call this once from main process init.
 */
export async function warmCache() {
  if (isDopplerConfigured()) {
    await fetchDopplerSecrets(true).catch(() => null)
  }
}
