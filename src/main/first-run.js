import { existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, delimiter } from 'node:path'
import { EventEmitter } from 'node:events'

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
// Responsibilities (only triggered when the venv is missing):
// 1. Copy OpenMontage source from read-only resourcesPath to userData (one-time).
// 2. Create a Python venv under userData/openmontage/.venv using the bundled Python.
// 3. Upgrade pip + wheel.
// 4. Install OpenMontage's requirements.txt (the slow step — many minutes).
// 5. Write a marker file so subsequent launches skip all of the above.
//
// In dev mode, bootstrap is still invoked if no venv exists, but points at the repo's
// vendor/OpenMontage/ directory as usual.

const IS_WIN = process.platform === 'win32'
const MARKER_NAME = '.chatvas-bootstrap-ok'

export function bootstrapMarkerPath() {
  return join(omWorkingRoot(), MARKER_NAME)
}

export function isBootstrapped() {
  return existsSync(bootstrapMarkerPath()) && existsSync(omVenvPython())
}

function shouldSkipCopy(srcRoot, dstRoot) {
  // In dev, source === dest. Skip copy.
  return srcRoot === dstRoot
}

function copyOpenMontageToUserData(emit) {
  const src = omSourceRoot()
  const dst = omWorkingRoot()
  if (shouldSkipCopy(src, dst)) return
  if (existsSync(join(dst, 'requirements.txt'))) {
    emit('log', `[bootstrap] OpenMontage already present at ${dst} — skipping copy`)
    return
  }
  emit('step', { key: 'copy', label: 'Preparing OpenMontage workspace' })
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true, force: false })
  emit('log', `[bootstrap] copied OpenMontage → ${dst}`)
}

function runStream(emit, label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    emit('step', { key: label, label })
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (c) => emit('log', c.toString('utf-8')))
    child.stderr.on('data', (c) => emit('log', c.toString('utf-8')))
    child.on('error', reject)
    child.on('exit', (code) => {
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
  writeFileSync(bootstrapMarkerPath(), `ok ${new Date().toISOString()}\n`)
}

export class FirstRunBootstrapper extends EventEmitter {
  constructor() {
    super()
    this.running = false
    this.done = false
    this.error = null
    this.log = []
  }

  emitStep(payload) {
    this.emit('event', { type: 'step', payload })
  }
  emitLog(text) {
    if (!text) return
    const line = text.toString()
    this.log.push(line)
    if (this.log.join('').length > 50_000) this.log = this.log.slice(-200) // cap
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

