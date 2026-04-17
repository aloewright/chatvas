import { ipcMain, shell, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import { spawnSync } from 'node:child_process'

import { getSecret, setSecret, getSecretStatus, getModel, PROVIDER_KEYS } from './secrets.js'
import { listPipelinesAndTools } from './python-bridge.js'
import { startVideoJob } from './video-agent.js'
import { jobDir, readEvents, listJobs, deleteJob, enforceQuota, totalSize } from './artifact-store.js'

const jobs = new Map() // jobId -> { emitter, cancel, status, artifacts, windowId }

export function registerVideoIpc({ getMainWindow }) {
  let registryCache = null

  async function getRegistry(force = false) {
    if (!force && registryCache) return registryCache
    registryCache = await listPipelinesAndTools()
    return registryCache
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
      if (evt.type === 'status' && typeof evt.payload === 'string') entry.status = evt.payload
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
    entry.cancel()
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
    return {
      jobId,
      status: events.findLast?.((e) => e.type === 'status')?.payload || 'done',
      events,
      artifacts: events.filter((e) => e.type === 'artifact').map((e) => e.payload),
      workDir: jobDir(jobId)
    }
  })

  ipcMain.handle('video:doctor', async () => {
    const report = {
      python: checkCommand(['python3', '--version']) || checkCommand(['python', '--version']),
      ffmpeg: checkCommand(['ffmpeg', '-version']),
      node: process.version,
      setupComplete: existsSync(join(omRootPath(), '.chatvas-bootstrap-ok')),
      submoduleReady: existsSync(join(omRootPath(), 'requirements.txt')),
      secrets: getSecretStatus(),
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
    // Only returns presence (boolean), not the value.
    if (!PROVIDER_KEYS.includes(name) && name !== '__MODEL__') return { present: false }
    if (name === '__MODEL__') return { present: true, value: getModel() }
    return { present: !!getSecret(name) }
  })

  ipcMain.handle('video:setKey', (_e, { name, value }) => {
    setSecret(name, value)
    if (name === 'ANTHROPIC_API_KEY' || name === '__MODEL__') registryCache = null
    return { ok: true }
  })

  ipcMain.handle('video:openArtifact', (_e, { jobId, file }) => {
    const dir = jobDir(jobId)
    const target = file ? join(dir, file) : dir
    if (existsSync(target)) shell.showItemInFolder(target)
    return { ok: existsSync(target) }
  })

  ipcMain.handle('video:listRenders', () => {
    return { jobs: listJobs(), totalBytes: totalSize() }
  })

  ipcMain.handle('video:deleteRender', (_e, { jobId }) => {
    deleteJob(jobId)
    return { ok: true }
  })

  ipcMain.handle('video:enforceQuota', (_e, { quotaGb }) => {
    return enforceQuota(quotaGb || 20)
  })

  app.on('before-quit', () => {
    for (const entry of jobs.values()) {
      try { entry.cancel() } catch { /* ignore */ }
    }
  })
}

function omRootPath() {
  // Resolve from main file location: src/main/video-ipc.js -> project root/vendor/OpenMontage
  return fileURLToPath(new URL('../../vendor/OpenMontage', import.meta.url))
}

function checkCommand(cmd) {
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.error || res.status !== 0) return null
  return (res.stdout || res.stderr).toString().trim().split('\n')[0]
}
