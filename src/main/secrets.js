import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { ffmpegBinPathFragment } from './runtimes.js'

// Canonical list of keys the Video Studio understands.
// Anthropic is required; everything else unlocks a provider.
export const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'FAL_KEY',
  'PEXELS_API_KEY',
  'PIXABAY_API_KEY',
  'UNSPLASH_ACCESS_KEY',
  'SUNO_API_KEY',
  'ELEVENLABS_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_API_KEY',
  'HEYGEN_API_KEY',
  'RUNWAY_API_KEY'
]

// Non-secret pseudo-settings stored in the same blob.
export const PSEUDO_KEYS = [
  '__MODEL__',
  '__AI_TERMINAL_PROVIDER__',
  '__DOPPLER_TOKEN__',
  '__DOPPLER_PROJECT__',
  '__DOPPLER_CONFIG__',
  '__CF_WORKER_URL__',
  '__CF_API_TOKEN__',
  // better-auth session bearer token (from auth.pdx.software)
  '__AUTH_SESSION_TOKEN__'
]

const VALID_KEYS = new Set([...PROVIDER_KEYS, ...PSEUDO_KEYS])
const DEFAULT_MODEL = 'claude-opus-4-7'

let _warnedNoEncryption = false

function secretsPath() {
  return join(app.getPath('userData'), 'secrets.json')
}

function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

function readBlob() {
  const p = secretsPath()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return {} }
}

function writeBlob(blob) {
  const p = secretsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(blob, null, 2), { mode: 0o600 })
  // `mode` is only honored on create — chmod on every write so an older file with
  // looser permissions gets tightened.
  try { chmodSync(p, 0o600) } catch { /* best-effort on non-POSIX */ }
}

function encrypt(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (encryptionAvailable()) {
    return { enc: 'safeStorage', data: safeStorage.encryptString(value).toString('base64') }
  }
  if (!_warnedNoEncryption) {
    console.warn('[secrets] safeStorage encryption unavailable — secrets will be stored in plaintext. Install gnome-keyring or kwallet for encrypted storage on Linux.')
    _warnedNoEncryption = true
  }
  return { enc: 'plain', data: value }
}

function decrypt(entry) {
  if (!entry) return null
  if (entry.enc === 'safeStorage' && encryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(entry.data, 'base64')) } catch { return null }
  }
  if (entry.enc === 'plain') return entry.data
  return null
}

export function getSecret(name) {
  if (!VALID_KEYS.has(name)) return null
  return decrypt(readBlob()[name])
}

export function setSecret(name, value) {
  if (!VALID_KEYS.has(name)) throw new Error(`Unknown secret key: ${name}`)
  const blob = readBlob()
  if (value === null || value === undefined || value === '') {
    delete blob[name]
  } else {
    blob[name] = encrypt(value)
  }
  writeBlob(blob)
}

// Cheap presence check — does not decrypt. Safe to return to the renderer.
export function getSecretStatus() {
  const blob = readBlob()
  const status = {}
  for (const k of PROVIDER_KEYS) {
    const entry = blob[k]
    status[k] = !!(entry && entry.data)
  }
  return status
}

// Whether the OS keyring / safeStorage backend is active. Renderer shows a warning if false.
export function isSecureStorage() {
  return encryptionAvailable()
}

export function getModel() {
  return getSecret('__MODEL__') || DEFAULT_MODEL
}

// Compose a complete env dict for a child process: merges in-memory secrets and prepends
// the bundled ffmpeg/ffprobe dirs to PATH so OpenMontage tools find them.
export function buildChildEnv(extra = {}) {
  const blob = readBlob()
  const env = { ...process.env }
  for (const k of PROVIDER_KEYS) {
    const v = decrypt(blob[k])
    if (v) env[k] = v
  }
  const fragment = ffmpegBinPathFragment()
  if (fragment) {
    env.PATH = env.PATH ? `${fragment}${delimiter}${env.PATH}` : fragment
  }
  return { ...env, ...extra }
}
