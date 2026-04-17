#!/usr/bin/env node
// Bootstrap OpenMontage submodule using the bundled Python: venv, pip install, Remotion deps, .env stub.
// Safe to re-run; skips steps that are already done.

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
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

function step(label) { console.log(`\n[bootstrap] ▶ ${label}`) }

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.status !== 0) die(`command failed: ${cmd} ${args.join(' ')} (exit ${res.status})`)
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

function ensureSubmodule() {
  if (!existsSync(join(OM, 'requirements.txt'))) {
    die(`OpenMontage submodule not initialized at ${OM}. Run: git submodule update --init --recursive`)
  }
}

function ensureBundledPython() {
  const py = bundledPython()
  if (!existsSync(py)) {
    die(`Bundled Python not found at ${py}. Run: npm install (postinstall fetches Python automatically) or npm run install:python`)
  }
  try {
    const out = execSync(`"${py}" --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    const m = out.match(/(\d+)\.(\d+)/)
    if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 10)) {
      die(`bundled Python reports ${out}; need 3.10+. Reinstall with npm run install:python`)
    }
    console.log(`[bootstrap] bundled Python: ${out}`)
  } catch (e) {
    die(`could not run bundled Python: ${e.message}`)
  }
  return py
}

function ensureAdapterDir() { if (!existsSync(ADAPTER)) mkdirSync(ADAPTER, { recursive: true }) }

function ensureVenv(bundled) {
  if (existsSync(VENV_PY)) return
  step('Creating Python venv at vendor/OpenMontage/.venv')
  run(bundled, ['-m', 'venv', VENV])
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
  // Prepend OM to PYTHONPATH so user-configured paths still resolve.
  const pythonPath = process.env.PYTHONPATH ? `${OM}${delimiter}${process.env.PYTHONPATH}` : OM
  const res = spawnSync(VENV_PY, [script, '--warm'], {
    cwd: OM,
    env: { ...process.env, PYTHONPATH: pythonPath }
  })
  if (res.status !== 0) {
    console.warn('[bootstrap] registry warm-up exited non-zero (non-fatal)')
    if (res.stderr) process.stderr.write(res.stderr)
  }
}

function writeMarker() {
  writeFileSync(MARKER, `ok ${new Date().toISOString()}\n`)
}

ensureSubmodule()
ensureAdapterDir()
const bundled = ensureBundledPython()
ensureVenv(bundled)
upgradePip()
installPython()
installNode()
stubEnv()
warmRegistry()
writeMarker()

console.log('\n[bootstrap] ✓ Done. OpenMontage is ready.')
console.log('[bootstrap]   Launch chatvas with `npm run dev` and open Settings to add provider keys.')
