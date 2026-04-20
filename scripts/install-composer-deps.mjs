#!/usr/bin/env node
// Fast half of the OpenMontage bootstrap — runs at `npm install` / postinstall.
// Installs Remotion composer node_modules so the packaged `.app` ships Chromium headless shell
// and Remotion React deps. No Python work here (that's slow + optional until first-launch).

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const OM = join(ROOT, 'vendor', 'OpenMontage')
const COMPOSER = join(OM, 'remotion-composer')
const IS_WIN = process.platform === 'win32'

if (!existsSync(OM)) {
  console.log('[composer] vendor/OpenMontage missing — submodule not initialized; skipping')
  process.exit(0)
}
if (!existsSync(COMPOSER)) {
  console.log('[composer] remotion-composer dir missing; skipping')
  process.exit(0)
}
if (existsSync(join(COMPOSER, 'node_modules'))) {
  console.log('[composer] remotion-composer node_modules already present; skipping')
  process.exit(0)
}

console.log('[composer] installing Remotion composer deps (also triggers Chromium headless download)')
const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
  cwd: COMPOSER,
  stdio: 'inherit',
  shell: IS_WIN
})
if (res.status !== 0) {
  console.warn(`[composer] npm install in remotion-composer exited ${res.status} (non-fatal, retry with: cd vendor/OpenMontage/remotion-composer && npm install)`)
  process.exit(0)
}
console.log('[composer] done.')
