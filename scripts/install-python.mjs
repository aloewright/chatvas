#!/usr/bin/env node
// Downloads python-build-standalone and extracts a self-contained Python for the host platform.
// Idempotent — skips if vendor/python-runtime/<triple>/ already has a working interpreter.
// Runs automatically on `npm install` via the postinstall script.

import { existsSync, mkdirSync, createWriteStream, createReadStream, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_ROOT = join(ROOT, 'vendor', 'python-runtime')

// Pin to a specific python-build-standalone release so installs are reproducible.
// Bump both values together and refresh EXPECTED_SHA256 for every supported triple.
const PBS_RELEASE = '20260414'
const PYTHON_VERSION = '3.12.13'

// SHA-256 digests (lowercase hex, 64 chars) for each supported triple. Digests come from the
// release's per-asset `digest` field (visible in `gh api repos/astral-sh/python-build-standalone/releases/tags/...`).
// Verification is mandatory by default; setting CHATVAS_ALLOW_UNVERIFIED_PYTHON=1 downgrades
// a missing digest to a warning (useful if you're pinning a newer release before this table is updated).
const EXPECTED_SHA256 = {
  'x86_64-unknown-linux-gnu':   'cdcf8724d46e4857f8db5ee9f4252dc2f5da34f7940294ec6b312389dd3f41e0',
  'aarch64-unknown-linux-gnu':  '355d981eafb9b2870af79ddc106ced7266b6f6d2101d8fbcb05620fa386642b9',
  'x86_64-apple-darwin':        '801b03fbe004181d55a02ebd8b4e04d74973e70d716062aebe3b3cf32e9be297',
  'aarch64-apple-darwin':       '8966b2bcd9fa03ba22c080ad15a86bc12e41a00122b16f4b3740e302261124d9',
  'x86_64-pc-windows-msvc':     'c5a9e011e284c49c48106ca177342f3e3f64e95b4c6652d4a382cc7c9bb1cc46'
}
// Historical opt-in kept for back-compat; the flag no longer changes behavior (STRICT is now the default).
const ALLOW_UNVERIFIED = process.env.CHATVAS_ALLOW_UNVERIFIED_PYTHON === '1'

const IS_WIN = process.platform === 'win32'

function pythonTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : (process.arch === 'x64' ? 'x86_64' : process.arch)
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (IS_WIN) return `${arch}-pc-windows-msvc`
  return `${arch}-unknown-linux-gnu`
}

function assetName() {
  return `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${pythonTriple()}-install_only.tar.gz`
}

function assetUrl() {
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${encodeURIComponent(assetName())}`
}

function pythonExe(dir) {
  return IS_WIN ? join(dir, 'python', 'python.exe') : join(dir, 'python', 'bin', 'python3')
}

function log(msg) { console.log(`[install-python] ${msg}`) }
function die(msg) { console.error(`[install-python] ${msg}`); process.exit(1) }

async function download(url, outPath, attempt = 1) {
  const tmp = outPath + '.tmp'
  const ac = new AbortController()
  // Inactivity watchdog: abort if no bytes received for 120s (refresh on each chunk).
  const timer = setTimeout(() => ac.abort(new Error('download timed out after 120s of inactivity')), 120_000)

  try {
    log(`downloading ${url}`)
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    let lastPrintedDecile = -1
    const readable = Readable.fromWeb(res.body)
    readable.on('data', (c) => {
      timer.refresh()
      received += c.length
      if (total) {
        const pct = Math.floor((received / total) * 100)
        const decile = Math.floor(pct / 10)
        if (decile !== lastPrintedDecile) {
          process.stderr.write(`  ${pct}%\r`)
          lastPrintedDecile = decile
        }
      }
    })
    await pipeline(readable, createWriteStream(tmp))
    renameSync(tmp, outPath)
    log(`  ↳ saved ${outPath} (${(received / 1e6).toFixed(1)} MB)`)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    if (attempt >= 3) throw e
    const wait = [2000, 4000, 8000][attempt - 1] || 8000
    log(`  ↳ attempt ${attempt} failed (${e.message}); retrying in ${wait / 1000}s`)
    await new Promise((r) => setTimeout(r, wait))
    return download(url, outPath, attempt + 1)
  } finally {
    clearTimeout(timer)
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

class DigestMismatchError extends Error {
  constructor(triple, expected, actual) {
    super(`SHA-256 mismatch for ${triple}:\n  expected ${expected}\n  actual   ${actual}`)
    this.triple = triple
    this.expected = expected
    this.actual = actual
  }
}

async function verifyTarball(tarPath, triple) {
  const expected = EXPECTED_SHA256[triple]
  if (!expected) {
    const msg = `no pinned SHA-256 for ${triple}; integrity check skipped`
    if (!ALLOW_UNVERIFIED) {
      die(`${msg}. Either backfill EXPECTED_SHA256 for ${triple} or set CHATVAS_ALLOW_UNVERIFIED_PYTHON=1 to proceed.`)
    }
    log(`  ↳ WARN: ${msg} (CHATVAS_ALLOW_UNVERIFIED_PYTHON=1)`)
    return
  }
  log(`  ↳ verifying SHA-256`)
  const actual = await sha256File(tarPath)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new DigestMismatchError(triple, expected, actual)
  }
  log(`  ↳ SHA-256 OK`)
}

async function extract(tarGzPath, destDir) {
  log(`extracting to ${destDir}`)
  mkdirSync(destDir, { recursive: true })
  await tar.x({ file: tarGzPath, cwd: destDir })
}

function verify(destDir) {
  const py = pythonExe(destDir)
  if (!existsSync(py)) throw new Error(`python binary missing at ${py} after extract`)
  const res = spawnSync(py, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.status !== 0) throw new Error(`${py} --version failed`)
  log(`  ↳ ${(res.stdout || res.stderr).toString().trim()}`)
}

async function main() {
  const triple = pythonTriple()
  const destDir = join(OUT_ROOT, triple)
  const py = pythonExe(destDir)
  if (existsSync(py)) {
    const res = spawnSync(py, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (res.status === 0) {
      log(`already installed: ${(res.stdout || res.stderr).toString().trim()} @ ${py}`)
      return
    }
    log('existing install is broken; re-extracting')
    rmSync(destDir, { recursive: true, force: true })
  }
  mkdirSync(dirname(destDir), { recursive: true })

  const tarPath = join(OUT_ROOT, `${assetName()}`)
  if (!existsSync(tarPath)) {
    await download(assetUrl(), tarPath)
  } else {
    log(`using cached tarball ${tarPath}`)
  }

  try {
    await verifyTarball(tarPath, triple)
  } catch (e) {
    if (e instanceof DigestMismatchError) {
      // Cached tarball may be corrupt — re-download once and verify again.
      log(`  ↳ cached tarball failed verification; re-downloading`)
      try { rmSync(tarPath, { force: true }) } catch { /* ignore */ }
      await download(assetUrl(), tarPath)
      await verifyTarball(tarPath, triple)
    } else {
      throw e
    }
  }

  await extract(tarPath, destDir)
  verify(destDir)
  log('done.')
}

main().catch((e) => die(e.stack || e.message || String(e)))
