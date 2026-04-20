import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, delimiter } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

import {
  bundledPython,
  bundledPythonExists,
  omSourceRoot,
  omWorkingRoot,
  omVenvPython
} from './runtimes.js'
import { buildChildEnv } from './secrets.js'

// First-run bootstrap coordinator for the packaged app.
//
// Responsibilities:
// 1. Copy OpenMontage source from read-only resourcesPath to userData. Re-copy when
//    the bundled app version changes (userData tree gets stale on upgrades otherwise).
// 2. Create a Python venv under userData/openmontage/.venv using the bundled Python.
// 3. Upgrade pip + wheel.
// 4. Install OpenMontage's requirements.txt (the slow step — many minutes).
// 5. Write a marker file so subsequent launches skip all of the above.
//
// In dev mode, bootstrap is still invoked if no venv exists, but points at the repo's
// vendor/OpenMontage/ directory as usual (source === working, so copy is a no-op).

const require = createRequire(import.meta.url)
const MARKER_NAME = '.chatvas-bootstrap-ok'
const VERSION_NAME = '.bundled-version'

function appVersion() {
  try {
    const { app } = require('electron')
    return app?.getVersion?.() || 'dev'
  } catch { return 'dev' }
}

export function bootstrapMarkerPath() {
  return join(omWorkingRoot(), MARKER_NAME)
}

function versionMarkerPath() {
  return join(omWorkingRoot(), VERSION_NAME)
}

function readRecordedVersion() {
  const p = versionMarkerPath()
  if (!existsSync(p)) return null
  try { return readFileSync(p, 'utf-8').trim() } catch { return null }
}

export function isBootstrapped() {
  if (!existsSync(bootstrapMarkerPath())) return false
  if (!existsSync(omVenvPython())) return false
  // If the bundled app version has moved past what's recorded, force a re-bootstrap.
  const recorded = readRecordedVersion()
  if (recorded && recorded !== appVersion()) return false
  return true
}

function shouldSkipCopy(srcRoot, dstRoot) {
  // In dev, source === dest. Skip copy.
  return srcRoot === dstRoot
}

function copyOpenMontageToUserData(emit) {
  const src = omSourceRoot()
  const dst = omWorkingRoot()
  if (shouldSkipCopy(src, dst)) return

  const recorded = readRecordedVersion()
  const current = appVersion()
  const hasExistingCopy = existsSync(join(dst, 'requirements.txt'))

  if (hasExistingCopy && recorded === current) {
    emit('log', `[bootstrap] OpenMontage ${current} already present at ${dst} — skipping copy`)
    return
  }

  if (hasExistingCopy) {
    emit('step', { key: 'migrate', label: `Refreshing OpenMontage (${recorded || 'unknown'} → ${current})` })
    // Wipe .venv too — requirements.txt may have changed and a stale venv can mis-import.
    try { rmSync(dst, { recursive: true, force: true }) } catch (e) {
      emit('log', `[bootstrap] warn: could not remove ${dst}: ${e.message}`)
    }
  } else {
    emit('step', { key: 'copy', label: 'Preparing OpenMontage workspace' })
  }

  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true, force: false })
  writeFileSync(versionMarkerPath(), `${current}\n`)
  emit('log', `[bootstrap] copied OpenMontage ${current} → ${dst}`)
}

function runStream(emit, label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    emit('step', { key: label, label })
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (c) => emit('log', c.toString('utf-8')))
    child.stderr.on('data', (c) => emit('log', c.toString('utf-8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function createVenv(emit) {
  const venvPy = omVenvPython()
  if (existsSync(venvPy)) {
    emit('log', '[bootstrap] venv already present — skipping create')
    return
  }
  if (!bundledPythonExists()) {
    throw new Error(`Bundled Python not found at ${bundledPython()}. The app install is incomplete.`)
  }
  await runStream(emit, 'Creating Python environment', bundledPython(), ['-m', 'venv', join(omWorkingRoot(), '.venv')])
}

async function upgradePip(emit) {
  await runStream(emit, 'Upgrading pip', omVenvPython(), ['-m', 'pip', 'install', '-U', 'pip', 'wheel'])
}

async function installRequirements(emit) {
  const reqs = join(omWorkingRoot(), 'requirements.txt')
  if (!existsSync(reqs)) throw new Error(`requirements.txt missing at ${reqs}`)
  await runStream(
    emit,
    'Installing OpenMontage dependencies (this takes several minutes)',
    omVenvPython(),
    ['-m', 'pip', 'install', '-r', reqs],
    {
      env: buildChildEnv({
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: process.env.PYTHONPATH ? `${omWorkingRoot()}${delimiter}${process.env.PYTHONPATH}` : omWorkingRoot()
      })
    }
  )
}

function writeMarker() {
  writeFileSync(bootstrapMarkerPath(), `ok ${new Date().toISOString()} (app ${appVersion()})\n`)
}

export class FirstRunBootstrapper extends EventEmitter {
  constructor() {
    super()
    this.running = false
    this.done = false
    this.error = null
    this.log = []
  }

  emitStep(payload) { this.emit('event', { type: 'step', payload }) }
  emitLog(text) {
    if (!text) return
    const line = text.toString()
    this.log.push(line)
    if (this.log.join('').length > 50_000) this.log = this.log.slice(-200)
    this.emit('event', { type: 'log', payload: line })
  }

  async run() {
    if (this.running || this.done) return
    this.running = true
    this.error = null

    const emit = (type, payload) => {
      if (type === 'step') this.emitStep(payload)
      else if (type === 'log') this.emitLog(payload)
    }

    try {
      copyOpenMontageToUserData(emit)
      await createVenv(emit)
      await upgradePip(emit)
      await installRequirements(emit)
      writeMarker()
      this.done = true
      this.emit('event', { type: 'done', payload: { markerPath: bootstrapMarkerPath() } })
    } catch (e) {
      this.error = e
      this.emit('event', { type: 'error', payload: { message: e.message } })
      throw e
    } finally {
      this.running = false
    }
  }
}
