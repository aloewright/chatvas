#!/usr/bin/env node
// Preflight doctor: verifies Python 3.10+, FFmpeg, Node 18+, and whether OpenMontage bootstrap has run.
// Prints a colored pass/fail table. Exits 0 on all green, 1 otherwise.

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const OM = join(ROOT, 'vendor', 'OpenMontage')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const rows = []
let hardFail = false

function check(label, fn) {
  try {
    const detail = fn()
    rows.push({ label, status: 'ok', detail })
  } catch (e) {
    hardFail = true
    rows.push({ label, status: 'fail', detail: e.message })
  }
}

function exec(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function parseMajorMinor(s) {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) throw new Error(`cannot parse version from: ${s}`)
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

check('Python 3.10+', () => {
  let py
  try { py = exec('python3 --version') } catch { py = exec('python --version') }
  const [maj, min] = parseMajorMinor(py)
  if (maj < 3 || (maj === 3 && min < 10)) throw new Error(`found ${py}, need >= 3.10`)
  return py
})

check('FFmpeg', () => {
  const v = exec('ffmpeg -version').split('\n')[0]
  return v
})

check('Node 18+', () => {
  const v = process.version.replace(/^v/, '')
  const [maj] = parseMajorMinor(v)
  if (maj < 18) throw new Error(`found v${v}, need >= 18`)
  return `v${v}`
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

check('ANTHROPIC_API_KEY', () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('env var not set (the app stores this via Settings; unset here is OK for runtime)')
  }
  return 'set in shell env'
})

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
console.log('\nChatvas Video Studio — doctor\n')
for (const r of rows) {
  const icon = r.status === 'ok' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  const color = r.status === 'ok' ? GREEN : YELLOW
  console.log(`  ${icon} ${pad(r.label, 26)} ${color}${r.detail}${RESET}`)
}
console.log('')

process.exit(hardFail ? 1 : 0)
