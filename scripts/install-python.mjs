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

// SHA-256 digests for each supported triple (lowercase hex, 64 chars).
// null = digest unknown on this checkout; installation proceeds but logs a warning instead
// of verifying. Backfill as each platform is tested. Set CHATVAS_STRICT_SHA=1 to force a
// hard failure on missing digests (useful for CI signing workflows).
const EXPECTED_SHA256 = {
  'x86_64-unknown-linux-gnu': 'cdcf8724d46e4857f8db5ee9f4252dc2f5da34f7940294ec6b312389dd3f41e0',
  'aarch64-unknown-linux-gnu': null,
  'x86_64-apple-darwin': null,
  'aarch64-apple-darwin': null,
  'x86_64-pc-windows-msvc': null
}
const STRICT = process.env.CHATVAS_STRICT_SHA === '1'

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
  try {
    log(`downloading ${url}`)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    const tmp = outPath + '.tmp'
    let received = 0
    const readable = Readable.fromWeb(res.body)
    readable.on('data', (c) => {
      received += c.length
      if (total) {
        const pct = Math.floor((received / total) * 100)
        if (pct % 10 === 0) process.stderr.write(`  ${pct}%\r`)
      }
    })
    await pipeline(readable, createWriteStream(tmp))
    renameSync(tmp, outPath)
    log(`  ↳ saved ${outPath} (${(received / 1e6).toFixed(1)} MB)`)
  } catch (e) {
    if (attempt >= 3) throw e
    const wait = [2000, 4000, 8000][attempt - 1] || 8000
    log(`  ↳ attempt ${attempt} failed (${e.message}); retrying in ${wait / 1000}s`)
    await new Promise((r) => setTimeout(r, wait))
    return download(url, outPath, attempt + 1)
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function verifyTarball(tarPath, triple) {
  const expected = EXPECTED_SHA256[triple]
  if (!expected) {
    const msg = `no pinned SHA-256 for ${triple}; skipping integrity check`
    if (STRICT) die(`${msg} (CHATVAS_STRICT_SHA=1 requires a pinned digest)`)
    log(`  ↳ warn: ${msg}`)
    return
  }
  log(`  ↳ verifying SHA-256`)
  const actual = await sha256File(tarPath)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    try { rmSync(tarPath) } catch { /* ignore */ }
    die(`SHA-256 mismatch for ${triple}:\n  expected ${expected}\n  actual   ${actual}\n(deleted ${tarPath})`)
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
  await verifyTarball(tarPath, triple)
  await extract(tarPath, destDir)
  verify(destDir)
  // Leave the tarball on disk — re-extract if something gets corrupted, and delete-from-cache in a CI cleanup step.
  log('done.')
}

main().catch((e) => die(e.stack || e.message || String(e)))
