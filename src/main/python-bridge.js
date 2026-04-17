import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import treeKill from 'tree-kill'
import { buildChildEnv } from './secrets.js'

// Spawn a persistent `run_tool.py` process per job. One bridge handles
// multiple sequential tool calls for the lifetime of a job.

const IS_WIN = process.platform === 'win32'

function repoRoot() {
  // src/main/python-bridge.js -> project root (out/main/python-bridge.js after build)
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

function omRoot() {
  return join(repoRoot(), 'vendor', 'OpenMontage')
}

function venvPython() {
  const om = omRoot()
  return IS_WIN
    ? join(om, '.venv', 'Scripts', 'python.exe')
    : join(om, '.venv', 'bin', 'python')
}

function adapterPath(file) {
  return join(repoRoot(), 'vendor', 'OpenMontage-adapter', file)
}

export class PythonBridge {
  constructor({ onLog } = {}) {
    this.child = null
    this.rl = null
    this.ready = false
    this.readyPromise = null
    this.pending = new Map() // id -> { resolve, reject, onProgress, aborted }
    this.onLog = onLog || (() => {})
    this.shuttingDown = false
  }

  start() {
    if (this.readyPromise) return this.readyPromise

    const py = venvPython()
    if (!existsSync(py)) {
      return Promise.reject(new Error(
        `Python venv not found at ${py}. Run \`npm run setup:video\` first.`
      ))
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
      if (!this.shuttingDown) {
        const err = new Error(`python bridge exited (code=${code} signal=${signal})`)
        for (const { reject } of this.pending.values()) reject(err)
        this.pending.clear()
      }
      this.ready = false
      this.child = null
    })

    this.rl = readline.createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this._onLine(line))

    this.readyPromise = new Promise((resolvePromise, rejectPromise) => {
      this._readyResolve = resolvePromise
      this._readyReject = rejectPromise
      const timeout = setTimeout(() => {
        rejectPromise(new Error('python bridge startup timed out after 60s'))
      }, 60_000)
      this.readyPromise.finally(() => clearTimeout(timeout))
    })

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })

      const abortHandler = () => {
        this.pending.delete(id)
        reject(new Error('aborted'))
        // Escalate to kill the whole bridge so a half-executed tool doesn't linger.
        this.stop('SIGTERM')
      }
      if (signal) {
        if (signal.aborted) { abortHandler(); return }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      this.child.stdin.write(JSON.stringify({ id, tool, args }) + '\n')
    })
  }

  stop(signal = 'SIGTERM') {
    this.shuttingDown = true
    if (!this.child) return
    const pid = this.child.pid
    try {
      this.child.stdin?.write(JSON.stringify({ op: 'shutdown' }) + '\n')
    } catch { /* ignore */ }
    if (pid) {
      treeKill(pid, signal, () => {})
    }
  }
}

// One-shot invocation of `list_pipelines.py` — returns the full registry dump.
export function listPipelinesAndTools() {
  return new Promise((resolvePromise, rejectPromise) => {
    const py = venvPython()
    if (!existsSync(py)) {
      return rejectPromise(new Error(
        `Python venv not found at ${py}. Run \`npm run setup:video\` first.`
      ))
    }
    const env = buildChildEnv({ PYTHONPATH: omRoot(), PYTHONUNBUFFERED: '1' })
    const child = spawn(py, [adapterPath('list_pipelines.py')], { cwd: omRoot(), env })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c.toString('utf-8') })
    child.stderr.on('data', (c) => { err += c.toString('utf-8') })
    child.on('exit', (code) => {
      if (code === 0) {
        try { resolvePromise(JSON.parse(out)) } catch (e) { rejectPromise(new Error(`parse error: ${e.message}; stdout=${out.slice(0, 500)}`)) }
      } else {
        rejectPromise(new Error(`list_pipelines exited ${code}: ${err.slice(0, 500)}`))
      }
    })
  })
}
