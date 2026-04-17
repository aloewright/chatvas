#!/usr/bin/env node
// Bootstrap OpenMontage submodule: create Python venv, install deps, install Remotion deps, stub .env.
// Run once after `git submodule update --init --recursive`.
// Safe to re-run; skips steps that are already done.

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const OM = join(ROOT, 'vendor', 'OpenMontage')
const ADAPTER = join(ROOT, 'vendor', 'OpenMontage-adapter')
const MARKER = join(OM, '.chatvas-bootstrap-ok')
const IS_WIN = process.platform === 'win32'
const VENV = join(OM, '.venv')
const VENV_PY = IS_WIN ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python')
const VENV_PIP = IS_WIN ? join(VENV, 'Scripts', 'pip.exe') : join(VENV, 'bin', 'pip')

function die(msg) {
  console.error(`[bootstrap] ${msg}`)
  process.exit(1)
}

function step(label) {
  console.log(`\n[bootstrap] ▶ ${label}`)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.status !== 0) {
    die(`command failed: ${cmd} ${args.join(' ')} (exit ${res.status})`)
  }
}

function which(bin) {
  try {
    return execSync(`${IS_WIN ? 'where' : 'command -v'} ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split(/\r?\n/)[0]
  } catch {
    return null
  }
}

function ensureSubmodule() {
  if (!existsSync(join(OM, 'requirements.txt'))) {
    die(`OpenMontage submodule not initialized at ${OM}. Run: git submodule update --init --recursive`)
  }
}

function ensureAdapterDir() {
  if (!existsSync(ADAPTER)) mkdirSync(ADAPTER, { recursive: true })
}

function ensureVenv() {
  if (existsSync(VENV_PY)) return
  step('Creating Python venv at vendor/OpenMontage/.venv')
  const py = which('python3') || which('python')
  if (!py) die('python3 not found on PATH. Install Python 3.10+ and retry.')
  run(py, ['-m', 'venv', VENV])
}

function upgradePip() {
  step('Upgrading pip')
  run(VENV_PY, ['-m', 'pip', 'install', '-U', 'pip', 'wheel'])
}

function installPython() {
  step('Installing OpenMontage Python requirements (this may take several minutes)')
  run(VENV_PIP, ['install', '-r', join(OM, 'requirements.txt')])
}

function installNode() {
  step('Installing Remotion composer deps')
  const composer = join(OM, 'remotion-composer')
  if (!existsSync(composer)) {
    console.warn('[bootstrap] remotion-composer dir missing — skipping node install')
    return
  }
  run('npm', ['install'], { cwd: composer, shell: IS_WIN })
}

function stubEnv() {
  const envPath = join(OM, '.env')
  if (existsSync(envPath)) return
  const example = join(OM, '.env.example')
  if (existsSync(example)) {
    copyFileSync(example, envPath)
    console.log('[bootstrap] Created vendor/OpenMontage/.env from .env.example')
  } else {
    writeFileSync(envPath, '# OpenMontage provider keys — chatvas manages these via Settings\n')
  }
}

function warmRegistry() {
  step('Warming tool registry')
  const script = join(ADAPTER, 'list_pipelines.py')
  if (!existsSync(script)) {
    console.warn('[bootstrap] adapter list_pipelines.py missing — skipping registry warm')
    return
  }
  const res = spawnSync(VENV_PY, [script], {
    cwd: OM,
    env: { ...process.env, PYTHONPATH: OM }
  })
  if (res.status !== 0) {
    console.warn('[bootstrap] registry warm-up exited non-zero (this is non-fatal)')
    if (res.stderr) process.stderr.write(res.stderr)
  }
}

function writeMarker() {
  writeFileSync(MARKER, `ok ${new Date().toISOString()}\n`)
}

ensureSubmodule()
ensureAdapterDir()
ensureVenv()
upgradePip()
installPython()
installNode()
stubEnv()
warmRegistry()
writeMarker()

console.log('\n[bootstrap] ✓ Done. OpenMontage is ready.')
console.log('[bootstrap]   Launch chatvas with `npm run dev` and open the Settings drawer to add provider keys.')
