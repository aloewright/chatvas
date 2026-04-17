import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import treeKill from 'tree-kill'
import { buildChildEnv } from './secrets.js'
import { bundledPython, repoRoot } from './runtimes.js'

// Persistent `run_tool.py` subprocess per bridge instance. JSON-lines stdio.
// One bridge per video job; auto-torn-down on cancel or main process exit.

function omRoot() { return join(repoRoot(), 'vendor', 'OpenMontage') }
function adapterPath(file) { return join(repoRoot(), 'vendor', 'OpenMontage-adapter', file) }

// The OpenMontage venv is created from the bundled Python at bootstrap time.
// Path layout mirrors `python -m venv`'s output.
function venvPython() {
  const om = omRoot()
  return process.platform === 'win32'
    ? join(om, '.venv', 'Scripts', 'python.exe')
    : join(om, '.venv', 'bin', 'python')
}

function resolvePythonForBridge() {
  // Prefer the OpenMontage venv (it has OpenMontage's deps). Fall back to the bundled interpreter
  // so e.g. list_pipelines can still report whether discovery is possible.
  const venv = venvPython()
  if (existsSync(venv)) return { path: venv, source: 'venv' }
  const bundled = bundledPython()
  if (existsSync(bundled)) return { path: bundled, source: 'bundled' }
  return { path: null, source: 'missing' }
}

export class PythonBridge {
  constructor({ onLog } = {}) {
    this.child = null
    this.rl = null
    this.ready = false
    this.readyPromise = null
    this._readyResolve = null
    this._readyReject = null
    this._readyTimeout = null
    this.pending = new Map() // id -> { resolve, reject, onProgress }
    this.onLog = onLog || (() => {})
    this.shuttingDown = false
  }

  start() {
    if (this.readyPromise) return this.readyPromise

    const { path: py, source } = resolvePythonForBridge()
    if (!py) {
      return Promise.reject(new Error(
        `Python not found. Run \`npm install\` (bundles Python) then \`npm run setup:video\` (creates the OpenMontage venv).`
      ))
    }
    if (source === 'bundled') {
      this.onLog('[bridge] using bundled Python (no OpenMontage venv). Run `npm run setup:video` to install OpenMontage deps.\n')
    }

    const script = adapterPath('run_tool.py')
    const env = buildChildEnv({ PYTHONPATH: omRoot(), PYTHONUNBUFFERED: '1' })

    this.child = spawn(py, ['-u', script], {
      cwd: omRoot(),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.child.stderr.on('data', (chunk) => {
      this.onLog(chunk.toString('utf-8'))
    })

    this.child.on('exit', (code, signal) => {
      // Always reject pending — even during shutdown — so callers don't hang.
      if (this.pending.size > 0) {
        const err = new Error(`python bridge exited (code=${code} signal=${signal})`)
        for (const { reject } of this.pending.values()) reject(err)
        this.pending.clear()
      }
      if (this._readyTimeout) { clearTimeout(this._readyTimeout); this._readyTimeout = null }
      // Reject any unsettled start() promise so the next start() can retry.
      if (!this.ready && this._readyReject) {
        this._readyReject(new Error(`python bridge exited before ready (code=${code} signal=${signal})`))
      }
      this.ready = false
      this.child = null
      this.readyPromise = null
      this._readyResolve = null
      this._readyReject = null
    })

    this.rl = readline.createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this._onLine(line))

    let timeout
    this.readyPromise = new Promise((resolvePromise, rejectPromise) => {
      this._readyResolve = resolvePromise
      this._readyReject = rejectPromise
      timeout = setTimeout(() => {
        this.readyPromise = null
        rejectPromise(new Error('python bridge startup timed out after 60s'))
      }, 60_000)
    })
    this._readyTimeout = timeout
    this.readyPromise.finally(() => { if (timeout) { clearTimeout(timeout); this._readyTimeout = null } })

    return this.readyPromise
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch {
      this.onLog(`[bridge non-json stdout] ${line}\n`)
      return
    }

    if (msg.event === 'ready') {
      this.ready = true
      this._readyResolve?.(msg)
      return
    }

    if (msg.event === 'fatal') {
      const err = new Error(msg.error || 'fatal bridge error')
      err.traceback = msg.traceback
      this._readyReject?.(err)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      return
    }

    const id = msg.id
    const entry = this.pending.get(id)
    if (!entry) return

    if (msg.event === 'progress') {
      entry.onProgress?.(msg)
      return
    }
    if (msg.event === 'result') {
      this.pending.delete(id)
      if (msg.ok) entry.resolve(msg.result)
      else {
        const err = new Error(msg.error || 'tool failed')
        err.traceback = msg.traceback
        entry.reject(err)
      }
    }
  }

  async runTool(tool, args, { onProgress, signal } = {}) {
    await this.start()
    if (!this.ready) throw new Error('python bridge not ready')

    const id = randomUUID()
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, onProgress })

      const abortHandler = () => {
        if (this.pending.delete(id)) rejectPromise(new Error('aborted'))
        this.stop('SIGTERM')
      }
      if (signal) {
        if (signal.aborted) { abortHandler(); return }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      // Guard against a crashed/closed child: write may throw EPIPE/ERR_STREAM_WRITE_AFTER_END.
      const child = this.child
      if (!child || child.killed || !child.stdin || child.stdin.destroyed || child.stdin.writable === false) {
        this.pending.delete(id)
        rejectPromise(new Error('python bridge stdin is not writable'))
        return
      }
      try {
        child.stdin.write(JSON.stringify({ id, tool, args }) + '\n')
      } catch (e) {
        this.pending.delete(id)
        rejectPromise(new Error(`failed to write to python bridge: ${e.message}`))
      }
    })
  }

  stop(signal = 'SIGTERM') {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.pending.size > 0) {
      const err = new Error(`python bridge stopped (${signal})`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    }
    if (!this.child) return
    const pid = this.child.pid
    try { this.child.stdin?.write(JSON.stringify({ op: 'shutdown' }) + '\n') } catch { /* ignore */ }
    if (pid) treeKill(pid, signal, () => {})
  }
}

// One-shot invocation of `list_pipelines.py`.
export function listPipelinesAndTools() {
  return new Promise((resolvePromise, rejectPromise) => {
    const { path: py, source } = resolvePythonForBridge()
    if (!py) {
      return rejectPromise(new Error(
        'Python not installed. Run `npm install` (bundles Python) and then `npm run setup:video`.'
      ))
    }
    const env = buildChildEnv({ PYTHONPATH: omRoot(), PYTHONUNBUFFERED: '1' })
    const args = [adapterPath('list_pipelines.py')]
    if (source === 'venv') args.push('--warm')
    const child = spawn(py, args, { cwd: omRoot(), env })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c.toString('utf-8') })
    child.stderr.on('data', (c) => { err += c.toString('utf-8') })
    child.on('exit', (code) => {
      if (code === 0) {
        try { resolvePromise(JSON.parse(out)) } catch (e) {
          rejectPromise(new Error(`parse error: ${e.message}; stdout=${out.slice(0, 500)}`))
        }
      } else {
        rejectPromise(new Error(`list_pipelines exited ${code}: ${err.slice(0, 500)}`))
      }
    })
  })
}
