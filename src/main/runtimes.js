import { existsSync } from 'node:fs'
import { join, resolve, dirname, delimiter, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Resolve paths to bundled runtimes (Python, ffmpeg, ffprobe) in both dev and packaged modes.
// In dev: under vendor/python-runtime/ and node_modules/{ffmpeg,ffprobe}-static/.
// In packaged: Python lives under process.resourcesPath, ffmpeg/ffprobe binaries under
// app.asar.unpacked (electron-builder writes them there when asarUnpack matches).

const require = createRequire(import.meta.url)
const IS_WIN = process.platform === 'win32'

export function repoRoot() {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

// Packaged Electron apps expose app.isPackaged. Import lazily to avoid loading electron in the
// npm scripts that require this module (they should not hit this branch).
export function isPackaged() {
  try {
    const { app } = require('electron')
    return !!app?.isPackaged
  } catch { return false }
}

function pythonTriple() {
  // Mirrors the subdirectory names produced by scripts/install-python.mjs.
  const arch = process.arch === 'arm64' ? 'aarch64' : (process.arch === 'x64' ? 'x86_64' : process.arch)
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'win32')  return `${arch}-pc-windows-msvc`
  return `${arch}-unknown-linux-gnu`
}

export function pythonRuntimeRoot() {
  const triple = pythonTriple()
  if (isPackaged()) return join(process.resourcesPath, 'python-runtime', triple)
  return join(repoRoot(), 'vendor', 'python-runtime', triple)
}

// OpenMontage source root: read-only resourcesPath copy in packaged mode, repo submodule in dev.
export function omSourceRoot() {
  if (isPackaged()) return join(process.resourcesPath, 'OpenMontage')
  return join(repoRoot(), 'vendor', 'OpenMontage')
}

// OpenMontage working root: writable copy. userData/openmontage in packaged mode
// (for venv + any generated files), same as source in dev.
export function omWorkingRoot() {
  if (isPackaged()) {
    try {
      const { app } = require('electron')
      return join(app.getPath('userData'), 'openmontage')
    } catch {
      return join(process.resourcesPath, 'OpenMontage')
    }
  }
  return join(repoRoot(), 'vendor', 'OpenMontage')
}

export function adapterSourceRoot() {
  if (isPackaged()) return join(process.resourcesPath, 'vendor', 'OpenMontage-adapter')
  return join(repoRoot(), 'vendor', 'OpenMontage-adapter')
}

// Where the OpenMontage venv lives (always under the writable working root).
export function omVenvPython() {
  const root = omWorkingRoot()
  return IS_WIN
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python')
}

// python-build-standalone install_only layout: python/bin/python3 on unix, python/python.exe on Windows.
export function bundledPython() {
  const root = pythonRuntimeRoot()
  return IS_WIN
    ? join(root, 'python', 'python.exe')
    : join(root, 'python', 'bin', 'python3')
}

export function bundledPythonExists() {
  return existsSync(bundledPython())
}

// Translate a node_modules path inside the asar archive to its on-disk app.asar.unpacked twin
// so child_process can exec the binary.
function unpackedPath(p) {
  if (!p) return p
  if (!isPackaged()) return p
  const needle = `${sep}app.asar${sep}`
  const repl = `${sep}app.asar.unpacked${sep}`
  return p.includes(needle) ? p.replace(needle, repl) : p
}

export function bundledFfmpeg() {
  try {
    const mod = require('ffmpeg-static')
    const p = typeof mod === 'string' ? mod : mod?.default
    return unpackedPath(p) || null
  } catch { return null }
}

export function bundledFfprobe() {
  try {
    const mod = require('ffprobe-static')
    const p = typeof mod === 'string' ? mod : (mod?.path || mod?.default)
    return unpackedPath(p) || null
  } catch { return null }
}

// PATH fragment containing ffmpeg + ffprobe directories, joined by the platform delimiter.
export function ffmpegBinPathFragment() {
  const dirs = new Set()
  const f = bundledFfmpeg()
  const p = bundledFfprobe()
  if (f) dirs.add(dirname(f))
  if (p) dirs.add(dirname(p))
  return [...dirs].join(delimiter)
}

// Return { path: string, missing: string[] } describing the runtime state for doctor/IPC.
export function runtimeReport() {
  const missing = []
  const py = bundledPython()
  if (!existsSync(py)) missing.push('bundled-python')
  const f = bundledFfmpeg()
  if (!f || !existsSync(f)) missing.push('ffmpeg-static')
  const p = bundledFfprobe()
  if (!p || !existsSync(p)) missing.push('ffprobe-static')
  return { python: py, ffmpeg: f, ffprobe: p, missing, packaged: isPackaged() }
}
