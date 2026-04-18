#!/usr/bin/env node
// postinstall: init submodules and fetch bundled Python. Gated on the presence of .git so
// tarball/CI installs without a working tree don't produce noisy stderr.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'

function hasGit() {
  return existsSync(resolve(ROOT, '.git'))
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: IS_WIN, ...opts })
  return res.status === 0
}

// Skip entirely if this isn't a source checkout (e.g., installed as a dependency).
if (!hasGit()) {
  console.log('[postinstall] no .git — skipping submodule init and Python download')
  process.exit(0)
}

console.log('[postinstall] updating git submodules…')
run('git', ['submodule', 'update', '--init', '--recursive'])

console.log('[postinstall] fetching bundled Python…')
const pyOk = run(process.execPath, [resolve(__dirname, 'install-python.mjs')])
if (!pyOk) console.warn('[postinstall] Python download failed — you can retry with `npm run install:python`.')

console.log('[postinstall] installing Remotion composer deps…')
const composerOk = run(process.execPath, [resolve(__dirname, 'install-composer-deps.mjs')])
if (!composerOk) console.warn('[postinstall] composer install failed — video rendering may not work until fixed.')
