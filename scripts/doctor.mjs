#!/usr/bin/env node
// Preflight doctor: verifies bundled Python, bundled FFmpeg, Node 18+, OpenMontage bootstrap.
// Prints a colored pass/fail/warn table. Exits 0 if no hard failures.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const OM = join(ROOT, 'vendor', 'OpenMontage')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const IS_WIN = process.platform === 'win32'

const rows = []
let hardFail = false

function pushOk(label, detail) { rows.push({ label, status: 'ok', detail }) }
function pushWarn(label, detail) { rows.push({ label, status: 'warn', detail }) }
function pushFail(label, detail) { rows.push({ label, status: 'fail', detail }); hardFail = true }

function check(label, fn) {
  try {
    const detail = fn()
    if (detail && typeof detail === 'object' && detail.warn) pushWarn(label, detail.detail)
    else pushOk(label, detail)
  } catch (e) {
    pushFail(label, e.message)
  }
}

function execVersion(bin, args) {
  const res = spawnSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.error) throw new Error(res.error.message)
  const out = (res.stdout || res.stderr)?.toString() || ''
  if (res.status !== 0) throw new Error(out.split('\n')[0] || `exit ${res.status}`)
  return out.split('\n')[0].trim()
}

function pythonTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : (process.arch === 'x64' ? 'x86_64' : process.arch)
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (IS_WIN) return `${arch}-pc-windows-msvc`
  return `${arch}-unknown-linux-gnu`
}

function bundledPython() {
  const root = join(ROOT, 'vendor', 'python-runtime', pythonTriple())
  return IS_WIN ? join(root, 'python', 'python.exe') : join(root, 'python', 'bin', 'python3')
}

function bundledFfmpeg() {
  try {
    const m = require('ffmpeg-static')
    return typeof m === 'string' ? m : m?.default
  } catch { return null }
}

function bundledFfprobe() {
  try {
    const m = require('ffprobe-static')
    return typeof m === 'string' ? m : (m?.path || m?.default)
  } catch { return null }
}

check('Node 18+', () => {
  const v = process.version.replace(/^v/, '')
  const [maj] = v.split('.').map(Number)
  if (maj < 18) throw new Error(`found v${v}, need >= 18`)
  return `v${v}`
})

check('Bundled Python 3.10+', () => {
  const py = bundledPython()
  if (!existsSync(py)) {
    throw new Error(`not found at ${py} — run: npm install (postinstall fetches Python)`)
  }
  const v = execVersion(py, ['--version'])
  const m = v.match(/(\d+)\.(\d+)/)
  if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 10)) {
    throw new Error(`${v} — need 3.10+`)
  }
  return `${v} @ ${py}`
})

check('Bundled FFmpeg', () => {
  const p = bundledFfmpeg()
  if (!p) throw new Error('ffmpeg-static not installed — run: npm install')
  if (!existsSync(p)) throw new Error(`binary missing at ${p}`)
  return execVersion(p, ['-version'])
})

check('Bundled FFprobe', () => {
  const p = bundledFfprobe()
  if (!p) throw new Error('ffprobe-static not installed — run: npm install')
  if (!existsSync(p)) throw new Error(`binary missing at ${p}`)
  return execVersion(p, ['-version'])
})

check('OpenMontage submodule', () => {
  if (!existsSync(join(OM, 'requirements.txt'))) {
    throw new Error('not initialized — run: git submodule update --init --recursive')
  }
  return OM
})

check('OpenMontage bootstrap', () => {
  if (!existsSync(join(OM, '.chatvas-bootstrap-ok'))) {
    throw new Error('not bootstrapped — run: npm run setup:video')
  }
  return 'ready'
})

check('ANTHROPIC_API_KEY (env)', () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { warn: true, detail: 'not in shell env (OK — app stores via Settings)' }
  }
  return 'set in shell env'
})

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
console.log('\nChatvas Video Studio — doctor\n')
for (const r of rows) {
  let icon, color
  if (r.status === 'ok') { icon = `${GREEN}✓${RESET}`; color = GREEN }
  else if (r.status === 'warn') { icon = `${YELLOW}!${RESET}`; color = YELLOW }
  else { icon = `${RED}✗${RESET}`; color = RED }
  console.log(`  ${icon} ${pad(r.label, 26)} ${color}${r.detail}${RESET}`)
}
console.log('')

process.exit(hardFail ? 1 : 0)
