import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
export const PSEUDO_KEYS = ['__MODEL__']

const VALID_KEYS = new Set([...PROVIDER_KEYS, ...PSEUDO_KEYS])
const DEFAULT_MODEL = 'claude-opus-4-7'

function secretsPath() {
  return join(app.getPath('userData'), 'secrets.json')
}

function readBlob() {
  const p = secretsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeBlob(blob) {
  const p = secretsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(blob, null, 2), { mode: 0o600 })
}

function encrypt(value) {
  if (typeof value !== 'string') return null
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: 'safeStorage', data: safeStorage.encryptString(value).toString('base64') }
  }
  // Fallback: plaintext. Better than losing the value silently.
  return { enc: 'plain', data: value }
}

function decrypt(entry) {
  if (!entry) return null
  if (entry.enc === 'safeStorage' && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(entry.data, 'base64'))
    } catch {
      return null
    }
  }
  if (entry.enc === 'plain') return entry.data
  return null
}

export function getSecret(name) {
  if (!VALID_KEYS.has(name)) return null
  const blob = readBlob()
  return decrypt(blob[name])
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

// Booleans only — safe to return to the renderer.
export function getSecretStatus() {
  const blob = readBlob()
  const status = {}
  for (const k of PROVIDER_KEYS) status[k] = !!decrypt(blob[k])
  return status
}

export function getModel() {
  return getSecret('__MODEL__') || DEFAULT_MODEL
}

// Compose a complete env dict for a child process: merges OpenMontage .env fallback
// with in-memory secrets. Returns an object suitable for spawn({ env }).
export function buildChildEnv(extra = {}) {
  const blob = readBlob()
  const env = { ...process.env }
  for (const k of PROVIDER_KEYS) {
    const v = decrypt(blob[k])
    if (v) env[k] = v
  }
  return { ...env, ...extra }
}
