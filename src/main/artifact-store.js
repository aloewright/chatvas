import { app } from 'electron'
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_QUOTA_GB = 20
const EVENT_LOG = 'events.ndjson'
const MANIFEST = 'manifest.json'

export function rendersRoot() { return join(app.getPath('userData'), 'renders') }

export function jobDir(jobId) {
  const d = join(rendersRoot(), jobId)
  mkdirSync(d, { recursive: true })
  mkdirSync(join(d, 'workspace'), { recursive: true })
  return d
}

export function appendEvent(jobId, event) {
  appendFileSync(join(jobDir(jobId), EVENT_LOG), JSON.stringify(event) + '\n')
}

export function readEvents(jobId) {
  const p = join(rendersRoot(), jobId, EVENT_LOG)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

export function writeManifest(jobId, manifest) {
  writeFileSync(join(jobDir(jobId), MANIFEST), JSON.stringify(manifest, null, 2))
}

export function readManifest(jobId) {
  const p = join(rendersRoot(), jobId, MANIFEST)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}

// Async dir-size walk. Manifest-cached `bytes` takes precedence when present; otherwise walk.
async function computeDirSize(dir) {
  let total = 0
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
  await Promise.all(entries.map(async (e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) total += await computeDirSize(full)
    else {
      try { total += (await stat(full)).size } catch { /* ignore */ }
    }
  }))
  return total
}

export async function listJobs() {
  const root = rendersRoot()
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  const jobs = await Promise.all(entries
    .filter((d) => d.isDirectory())
    .map(async (d) => {
      const dir = join(root, d.name)
      const manifest = readManifest(d.name)
      const size = (manifest && typeof manifest.bytes === 'number') ? manifest.bytes : await computeDirSize(dir)
      return { jobId: d.name, dir, size, manifest }
    }))
  return jobs.sort((a, b) => (b.manifest?.createdAt || 0) - (a.manifest?.createdAt || 0))
}

export async function totalSize() {
  const jobs = await listJobs()
  return jobs.reduce((s, j) => s + j.size, 0)
}

// Update a manifest's cached byte count after a job completes (called by video-agent.js finalize).
export async function refreshManifestBytes(jobId) {
  const manifest = readManifest(jobId) || { jobId }
  const size = await computeDirSize(join(rendersRoot(), jobId))
  manifest.bytes = size
  writeManifest(jobId, manifest)
  return size
}

export function deleteJob(jobId) {
  const d = join(rendersRoot(), jobId)
  if (existsSync(d)) rmSync(d, { recursive: true, force: true })
}

// LRU eviction to keep total <= quotaGb. Never evicts a jobId in `excludedJobIds`.
export async function enforceQuota(quotaGb = DEFAULT_QUOTA_GB, excludedJobIds = new Set()) {
  const quota = quotaGb * 1024 * 1024 * 1024
  const jobs = await listJobs()
  let total = jobs.reduce((s, j) => s + j.size, 0)
  if (total <= quota) return { evicted: [], total, skipped: [] }

  const asc = [...jobs].sort((a, b) => (a.manifest?.createdAt || 0) - (b.manifest?.createdAt || 0))
  const evicted = []
  const skipped = []
  for (const j of asc) {
    if (total <= quota) break
    if (excludedJobIds.has(j.jobId)) { skipped.push(j.jobId); continue }
    deleteJob(j.jobId)
    evicted.push(j.jobId)
    total -= j.size
  }
  return { evicted, total, skipped }
}
