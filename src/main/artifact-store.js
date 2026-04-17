import { app } from 'electron'
import { existsSync, mkdirSync, statSync, readdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_QUOTA_GB = 20
const EVENT_LOG = 'events.ndjson'
const MANIFEST = 'manifest.json'

export function rendersRoot() {
  return join(app.getPath('userData'), 'renders')
}

export function jobDir(jobId) {
  const d = join(rendersRoot(), jobId)
  mkdirSync(d, { recursive: true })
  mkdirSync(join(d, 'workspace'), { recursive: true })
  return d
}

export function appendEvent(jobId, event) {
  const dir = jobDir(jobId)
  appendFileSync(join(dir, EVENT_LOG), JSON.stringify(event) + '\n')
}

export function readEvents(jobId) {
  const p = join(rendersRoot(), jobId, EVENT_LOG)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
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

export function listJobs() {
  const root = rendersRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(root, d.name)
      const size = dirSize(dir)
      const manifest = readManifest(d.name)
      return { jobId: d.name, dir, size, manifest }
    })
    .sort((a, b) => {
      const ta = a.manifest?.createdAt || 0
      const tb = b.manifest?.createdAt || 0
      return tb - ta
    })
}

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const p = stack.pop()
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = join(p, e.name)
      if (e.isDirectory()) stack.push(full)
      else {
        try { total += statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  return total
}

export function totalSize() {
  return listJobs().reduce((sum, j) => sum + j.size, 0)
}

export function deleteJob(jobId) {
  const d = join(rendersRoot(), jobId)
  if (existsSync(d)) rmSync(d, { recursive: true, force: true })
}

// LRU eviction to keep total <= quotaGb.
export function enforceQuota(quotaGb = DEFAULT_QUOTA_GB) {
  const quota = quotaGb * 1024 * 1024 * 1024
  let jobs = listJobs()
  let total = jobs.reduce((s, j) => s + j.size, 0)
  if (total <= quota) return { evicted: [], total }
  const asc = [...jobs].sort((a, b) => {
    const ta = a.manifest?.createdAt || 0
    const tb = b.manifest?.createdAt || 0
    return ta - tb
  })
  const evicted = []
  for (const j of asc) {
    if (total <= quota) break
    deleteJob(j.jobId)
    evicted.push(j.jobId)
    total -= j.size
  }
  return { evicted, total }
}
