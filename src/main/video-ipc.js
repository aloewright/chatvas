import { ipcMain, shell, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import { spawnSync } from 'node:child_process'

import { getSecret, setSecret, getSecretStatus, getModel, isSecureStorage, PROVIDER_KEYS } from './secrets.js'
import { listPipelinesAndTools } from './python-bridge.js'
import { startVideoJob } from './video-agent.js'
import { jobDir, readEvents, listJobs, deleteJob, enforceQuota, totalSize } from './artifact-store.js'
import { runtimeReport, bundledPython, bundledFfmpeg, bundledFfprobe } from './runtimes.js'

const jobs = new Map() // jobId -> { emitter, cancel, status, artifacts, workDir }
const TERMINAL = new Set(['done', 'error', 'cancelled'])
const TOMBSTONE_MS = 60_000

export function registerVideoIpc({ getMainWindow }) {
  let registryCache = null

  async function getRegistry(force = false) {
    if (!force && registryCache) return registryCache
    registryCache = await listPipelinesAndTools()
    return registryCache
  }

  function invalidateRegistry() {
    registryCache = null
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('video:registry-invalidated', { ts: Date.now() })
    }
  }

  function cleanupJob(jobId) {
    const entry = jobs.get(jobId)
    if (!entry) return
    try { entry.emitter?.removeAllListeners() } catch { /* ignore */ }
    entry.artifacts = []
    entry.emitter = null
    entry.cancel = null
    jobs.delete(jobId)
  }

  ipcMain.handle('video:listPipelines', async () => {
    const reg = await getRegistry()
    return { pipelines: reg.pipelines || [] }
  })

  ipcMain.handle('video:listTools', async () => {
    const reg = await getRegistry()
    return { tools: reg.tools || {}, providers: reg.providers || {} }
  })

  ipcMain.handle('video:start', async (_e, { nodeId, prompt, pipelineId, parentContext }) => {
    const jobId = `job-${Date.now()}-${nanoid(8)}`
    const win = getMainWindow()

    const handle = startVideoJob({
      jobId,
      prompt,
      pipelineId: pipelineId || null,
      parentContext: parentContext || null,
      onEvent: (evt) => {
        if (!win || win.isDestroyed()) return
        win.webContents.send('video:stream', evt)
      }
    })

    const entry = {
      jobId,
      nodeId,
      status: 'running',
      artifacts: [],
      cancel: handle.cancel,
      emitter: handle.emitter,
      workDir: handle.workDir
    }
    handle.emitter.on('event', (evt) => {
      if (evt.type === 'artifact') entry.artifacts.push(evt.payload)
      if (evt.type === 'status' && typeof evt.payload === 'string') {
        entry.status = evt.payload
        if (TERMINAL.has(evt.payload)) {
          // Keep a short tombstone so late video:getJob calls can still hit in-memory state.
          setTimeout(() => cleanupJob(jobId), TOMBSTONE_MS).unref?.()
        }
      }
    })
    handle.promise.catch((e) => {
      entry.status = 'error'
      if (!win || win.isDestroyed()) return
      win.webContents.send('video:stream', {
        jobId, ts: Date.now(), type: 'log',
        payload: { stream: 'agent', text: `FATAL: ${e.message}` }
      })
      win.webContents.send('video:stream', {
        jobId, ts: Date.now(), type: 'status', payload: 'error'
      })
    })

    jobs.set(jobId, entry)
    return { jobId, workDir: handle.workDir }
  })

  ipcMain.handle('video:cancel', (_e, { jobId }) => {
    const entry = jobs.get(jobId)
    if (!entry) return { ok: false, error: 'unknown job' }
    entry.cancel?.()
    return { ok: true }
  })

  ipcMain.handle('video:getJob', (_e, { jobId }) => {
    const entry = jobs.get(jobId)
    if (entry) {
      return {
        jobId,
        status: entry.status,
        artifacts: entry.artifacts,
        workDir: entry.workDir,
        events: readEvents(jobId)
      }
    }
    // Completed job — reconstruct from disk.
    const events = readEvents(jobId)
    if (events.length === 0) return null
    const terminal = [...events].reverse().find((e) => e.type === 'status')?.payload
    return {
      jobId,
      status: terminal || 'done',
      events,
      artifacts: events.filter((e) => e.type === 'artifact').map((e) => e.payload),
      workDir: jobDir(jobId)
    }
  })

  ipcMain.handle('video:doctor', async () => {
    const rt = runtimeReport()
    const report = {
      python: rt.python,
      ffmpeg: rt.ffmpeg,
      ffprobe: rt.ffprobe,
      missing: rt.missing,
      packaged: rt.packaged,
      node: process.version,
      pythonVersion: checkVersion(bundledPython(), ['--version']),
      ffmpegVersion: checkVersion(bundledFfmpeg(), ['-version']),
      setupComplete: existsSync(join(omRootPath(), '.chatvas-bootstrap-ok')),
      submoduleReady: existsSync(join(omRootPath(), 'requirements.txt')),
      secrets: getSecretStatus(),
      secureStorage: isSecureStorage(),
      model: getModel()
    }
    try {
      const reg = await getRegistry(true)
      report.pipelineCount = (reg.pipelines || []).length
      report.toolCount = Object.keys(reg.tools || {}).length
      report.registryError = null
    } catch (e) {
      report.pipelineCount = 0
      report.toolCount = 0
      report.registryError = e.message
    }
    return report
  })

  ipcMain.handle('video:getKey', (_e, { name }) => {
    // Provider keys: return presence only (never the secret).
    // __MODEL__ is not a secret — return the actual value so the UI can display it.
    if (name === '__MODEL__') return { present: true, value: getModel() }
    if (!PROVIDER_KEYS.includes(name)) return { present: false }
    return { present: !!getSecret(name) }
  })

  ipcMain.handle('video:setKey', (_e, { name, value }) => {
    setSecret(name, value)
    if (name === 'ANTHROPIC_API_KEY' || name === '__MODEL__') invalidateRegistry()
    return { ok: true }
  })

  ipcMain.handle('video:openArtifact', (_e, { jobId, file }) => {
    const dir = jobDir(jobId)
    const target = file ? join(dir, file) : dir
    if (existsSync(target)) shell.showItemInFolder(target)
    return { ok: existsSync(target) }
  })

  // Returns a chatvas-media:// URL backed by a privileged scheme registered in main/index.js.
  // Handles Windows paths correctly via URL encoding.
  ipcMain.handle('video:getFileUrl', (_e, { path }) => {
    if (!path || !existsSync(path)) return { url: null, error: 'not found' }
    const encoded = encodeURIComponent(path)
    return { url: `chatvas-media://media/${encoded}` }
  })

  ipcMain.handle('video:listRenders', async () => {
    const items = await listJobs()
    const total = await totalSize()
    return { jobs: items, totalBytes: total }
  })

  ipcMain.handle('video:deleteRender', (_e, { jobId }) => {
    if (jobs.has(jobId)) return { ok: false, error: 'job is active' }
    deleteJob(jobId)
    return { ok: true }
  })

  ipcMain.handle('video:enforceQuota', async (_e, { quotaGb }) => {
    const exclude = new Set()
    for (const [jobId, entry] of jobs.entries()) {
      if (!TERMINAL.has(entry.status)) exclude.add(jobId)
    }
    return enforceQuota(typeof quotaGb === 'number' ? quotaGb : 20, exclude)
  })

  app.on('before-quit', () => {
    for (const [jobId, entry] of jobs.entries()) {
      try { entry.cancel?.() } catch { /* ignore */ }
      cleanupJob(jobId)
    }
  })
}

function omRootPath() {
  return fileURLToPath(new URL('../../vendor/OpenMontage', import.meta.url))
}

function checkVersion(path, args) {
  if (!path || !existsSync(path)) return null
  try {
    const res = spawnSync(path, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (res.status !== 0) return null
    return (res.stdout || res.stderr).toString().trim().split('\n')[0]
  } catch { return null }
}
