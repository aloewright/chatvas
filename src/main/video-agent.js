import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import treeKill from 'tree-kill'
import { z } from 'zod'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'

import { PythonBridge, listPipelinesAndTools } from './python-bridge.js'
import { getModel, getSecret, buildChildEnv } from './secrets.js'
import { jobDir, appendEvent, writeManifest, refreshManifestBytes } from './artifact-store.js'
import { omWorkingRoot } from './runtimes.js'

const IS_WIN = process.platform === 'win32'
const MAX_READ_BYTES = 1_000_000           // 1 MB cap on read_file
const STDERR_TAIL_BYTES = 4096             // bounded ring buffer for render stderr
const LOG_EVENT_CAP = 2000                 // chars — prevents absurd payloads from drowning the renderer

function omRoot() { return omWorkingRoot() }

// Path whitelist: read-only access limited to these prefixes plus the job dir.
function readableRoots(workDir) {
  const om = omRoot()
  return [
    join(om, 'skills'),
    join(om, 'pipeline_defs'),
    join(om, 'schemas'),
    join(om, 'styles'),
    join(om, 'AGENT_GUIDE.md'),
    join(om, 'PROJECT_CONTEXT.md'),
    join(om, 'PROMPT_GALLERY.md'),
    workDir
  ]
}

function isUnder(child, parent) {
  const c = resolve(child) + sep
  const p = resolve(parent) + sep
  return c.startsWith(p) || resolve(child) === resolve(parent)
}

function readIfPresent(path) {
  if (!existsSync(path)) return ''
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

// Deterministic, bounded-size JSON serialization for log payloads.
function truncate(v, max = LOG_EVENT_CAP) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s.length <= max) return v
    return s.slice(0, max) + `…(+${s.length - max}b)`
  } catch {
    return '[unserializable]'
  }
}

function buildSystemPrompt({ workDir, pipelineId }) {
  const om = omRoot()
  const parts = []
  parts.push(
`You are the Video Studio orchestrator embedded in chatvas, an Electron app.
Your job is to produce an MP4 video by driving the OpenMontage toolchain via the
tools provided in this session. Do not attempt to edit files outside the job
working directory. Do not ask the user clarifying questions unless absolutely
required — use reasonable defaults and proceed.

Job working directory (absolute): ${workDir}
All intermediate artifacts (scripts, audio, frames, captions, JSON) MUST be
written under ${workDir}. The final video must land at ${join(workDir, 'out.mp4')}.

When you are finished, call the \`finalize\` tool with a short summary and the
absolute path to the final mp4. Only call finalize once you can verify the mp4
exists and plays.`
  )

  parts.push('\n\n=== OpenMontage AGENT_GUIDE.md ===\n' + readIfPresent(join(om, 'AGENT_GUIDE.md')))
  parts.push('\n\n=== OpenMontage PROJECT_CONTEXT.md ===\n' + readIfPresent(join(om, 'PROJECT_CONTEXT.md')))

  if (pipelineId) {
    const manifest = join(om, 'pipeline_defs', `${pipelineId}.yaml`)
    parts.push(`\n\n=== Pipeline manifest: ${pipelineId} ===\n` + readIfPresent(manifest))
  }

  parts.push(
`\n\n=== Tool usage rules ===
- Use \`list_pipelines\` / \`list_tools\` to discover capabilities before work.
- Use \`run_openmontage_tool\` with the \`name\` of a registered tool and its
  \`args\` dict to invoke any OpenMontage Python tool. Inputs follow each tool's
  input_schema (see list_tools output).
- Use \`read_file\` to read skill markdown, pipeline YAML, or files inside the
  job dir. Absolute paths only.
- Use \`write_job_file\` to stash intermediate JSON, SRT, plans, etc.
- Use \`render_remotion\` to invoke the Remotion composer for final rendering.
- Use \`finalize\` to terminate the job successfully.

Prefer premium providers when available (HeyGen, Runway, ElevenLabs, Suno,
FLUX-Pro). The runtime merges secret API keys into tool environments — you do
not need to handle keys yourself.`
  )

  return parts.join('')
}

function buildBranchContext(parentContext) {
  if (!parentContext) return ''
  const { parentPrompt, parentJobId, parentSummary } = parentContext
  return `\n\n=== Parent job context ===\nParent job: ${parentJobId}\nParent prompt: ${parentPrompt}\nParent finalize summary:\n${parentSummary || '(none)'}\n\nThe user has asked for an alternate variant. Retain the script and story beats unless the new directive demands otherwise; change style/pipeline as instructed.`
}

export function startVideoJob({ jobId, prompt, pipelineId, parentContext, abortSignal, onEvent }) {
  const emitter = new EventEmitter()
  const workDir = jobDir(jobId)
  const startedAt = Date.now()

  const emit = (type, payload) => {
    const evt = { jobId, ts: Date.now(), type, payload }
    try { appendEvent(jobId, evt) } catch { /* disk full? ignore */ }
    try { onEvent?.(evt) } catch { /* renderer gone */ }
    emitter.emit('event', evt)
  }

  const bridge = new PythonBridge({
    onLog: (chunk) => emit('log', { stream: 'python', text: chunk })
  })

  const activeChildren = new Set()
  function registerChild(child) {
    if (!child?.pid) return
    activeChildren.add(child.pid)
    child.once('exit', () => activeChildren.delete(child.pid))
  }
  function killAllChildren() {
    for (const pid of activeChildren) treeKill(pid, 'SIGTERM', () => {})
    activeChildren.clear()
    bridge.stop('SIGTERM')
  }

  const ac = new AbortController()
  if (abortSignal) {
    if (abortSignal.aborted) ac.abort()
    else abortSignal.addEventListener('abort', () => ac.abort(), { once: true })
  }
  ac.signal.addEventListener('abort', () => killAllChildren(), { once: true })

  // ---- Tool definitions ----

  const t_listPipelines = tool(
    'list_pipelines',
    'List OpenMontage pipeline manifests with id, name, path.',
    {},
    async () => {
      const envelope = await listPipelinesAndTools()
      return { content: [{ type: 'text', text: JSON.stringify({ pipelines: envelope.pipelines }, null, 2) }] }
    }
  )

  const t_listTools = tool(
    'list_tools',
    'List all OpenMontage tools with names, capabilities, availability, and input_schema.',
    {},
    async () => {
      const envelope = await listPipelinesAndTools()
      const tools = {}
      for (const [name, info] of Object.entries(envelope.tools || {})) {
        tools[name] = {
          name: info.name,
          capability: info.capability,
          provider: info.provider,
          status: info.status,
          runtime: info.runtime,
          best_for: info.best_for,
          input_schema: info.input_schema
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ tools, providers: envelope.providers }, null, 2) }] }
    }
  )

  const t_runTool = tool(
    'run_openmontage_tool',
    'Invoke a registered OpenMontage tool by name with an args dict. Returns the tool result including success/error, artifacts, duration_seconds, and cost_usd.',
    {
      name: z.string().describe('Exact tool name from list_tools (e.g., script.generate_outline)'),
      args: z.record(z.string(), z.any()).describe('Tool input dict matching the tool input_schema')
    },
    async ({ name, args }) => {
      emit('tool_call_start', { tool: name, args: truncate(args) })
      try {
        const res = await bridge.runTool(name, args, {
          signal: ac.signal,
          onProgress: (p) => emit('render_progress', { tool: name, pct: p.pct, message: p.message })
        })
        emit('tool_call_end', { tool: name, ok: true, result: truncate(res) })
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
      } catch (e) {
        emit('tool_call_end', { tool: name, ok: false, error: e.message })
        return {
          content: [{ type: 'text', text: `Tool ${name} failed: ${e.message}\n${e.traceback || ''}` }],
          is_error: true
        }
      }
    }
  )

  const t_readFile = tool(
    'read_file',
    'Read an absolute path inside OpenMontage skills/, pipeline_defs/, schemas/, styles/, or the current job working directory. Returns UTF-8 text; rejects binaries and files > 1 MB.',
    {
      path: z.string().describe('Absolute path to a file. Must be under an allowed root.')
    },
    async ({ path }) => {
      const roots = readableRoots(workDir)
      const allowed = roots.some((r) => isUnder(path, r) || resolve(path) === resolve(r))
      if (!allowed) {
        return { content: [{ type: 'text', text: `Path ${path} is not under an allowed root. Allowed: ${roots.join(', ')}` }], is_error: true }
      }
      if (!existsSync(path)) {
        return { content: [{ type: 'text', text: `File not found: ${path}` }], is_error: true }
      }
      let size
      try { size = statSync(path).size } catch { size = -1 }
      if (size < 0) return { content: [{ type: 'text', text: `stat failed: ${path}` }], is_error: true }
      if (size > MAX_READ_BYTES) {
        return { content: [{ type: 'text', text: `File too large (${size} bytes > ${MAX_READ_BYTES})` }], is_error: true }
      }
      const buf = readFileSync(path)
      // Coarse binary detection: reject if a NUL byte is in the first 8KB.
      const head = buf.subarray(0, Math.min(buf.length, 8192))
      if (head.includes(0)) {
        return { content: [{ type: 'text', text: `Binary content detected; refusing to read ${path}` }], is_error: true }
      }
      return { content: [{ type: 'text', text: buf.toString('utf-8') }] }
    }
  )

  const t_writeJobFile = tool(
    'write_job_file',
    'Write a text file under the job working directory (workspace/ or root). Use this for intermediate scripts, plans, SRT, JSON.',
    {
      relativePath: z.string().describe('Path relative to the job dir — e.g., workspace/script.json'),
      contents: z.string().describe('File contents')
    },
    async ({ relativePath, contents }) => {
      const target = resolve(workDir, relativePath)
      if (!isUnder(target, workDir)) {
        return { content: [{ type: 'text', text: 'path escapes job dir' }], is_error: true }
      }
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, contents)
      emit('log', { stream: 'agent', text: `wrote ${relative(workDir, target)} (${contents.length}b)` })
      return { content: [{ type: 'text', text: `wrote ${target}` }] }
    }
  )

  const SAFE_ARG = /^[A-Za-z0-9_\-.:/\\+ ]+$/
  const t_renderRemotion = tool(
    'render_remotion',
    'Run Remotion render against the composer bundle. Pass the composition id and a props JSON path (absolute). Output MP4 path is returned.',
    {
      compositionId: z.string().describe('Remotion composition id (e.g., Video)'),
      propsJsonAbsPath: z.string().describe('Absolute path to a JSON file holding props for the composition'),
      outputAbsPath: z.string().describe('Absolute path where the MP4 should be written')
    },
    async ({ compositionId, propsJsonAbsPath, outputAbsPath }) => {
      return await new Promise((resolvePromise) => {
        const composer = join(omRoot(), 'remotion-composer')
        if (!existsSync(composer)) {
          resolvePromise({ content: [{ type: 'text', text: `remotion-composer not found at ${composer}` }], is_error: true })
          return
        }
        if (!isUnder(outputAbsPath, workDir)) {
          resolvePromise({ content: [{ type: 'text', text: `outputAbsPath must be under job dir ${workDir}` }], is_error: true })
          return
        }
        if (!isUnder(propsJsonAbsPath, workDir)) {
          resolvePromise({ content: [{ type: 'text', text: `propsJsonAbsPath must be under job dir ${workDir}` }], is_error: true })
          return
        }
        if (!existsSync(propsJsonAbsPath)) {
          resolvePromise({ content: [{ type: 'text', text: `props JSON not found: ${propsJsonAbsPath}` }], is_error: true })
          return
        }
        // Validate agent-controlled inputs before passing to spawn — no shell metacharacters.
        for (const s of [compositionId, propsJsonAbsPath, outputAbsPath]) {
          if (!SAFE_ARG.test(s)) {
            resolvePromise({ content: [{ type: 'text', text: `illegal characters in argument: ${s}` }], is_error: true })
            return
          }
        }
        if (!/^[A-Za-z0-9_-]+$/.test(compositionId)) {
          resolvePromise({ content: [{ type: 'text', text: `compositionId must match [A-Za-z0-9_-]+` }], is_error: true })
          return
        }

        const cmd = IS_WIN ? 'npx.cmd' : 'npx'
        const args = ['remotion', 'render', 'src/index.ts', compositionId, outputAbsPath, `--props=${propsJsonAbsPath}`]
        const env = buildChildEnv()
        const child = spawn(cmd, args, { cwd: composer, env, shell: false })
        registerChild(child)
        const abortHandler = () => { try { treeKill(child.pid, 'SIGTERM', () => {}) } catch { /* ignore */ } }
        ac.signal.addEventListener('abort', abortHandler, { once: true })

        let stderrTail = ''
        child.stdout.on('data', (chunk) => {
          const text = chunk.toString('utf-8')
          // Don't keep stdout in memory — just scan for progress and forward logs.
          const m = text.match(/(\d+)\s*%/g)
          if (m) {
            const last = m[m.length - 1]
            const pct = parseInt(last, 10)
            if (!Number.isNaN(pct)) emit('render_progress', { tool: 'render_remotion', pct })
          }
          emit('log', { stream: 'remotion', text })
        })
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString('utf-8')
          stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES)
          emit('log', { stream: 'remotion', text })
        })
        child.on('error', (e) => {
          ac.signal.removeEventListener('abort', abortHandler)
          resolvePromise({ content: [{ type: 'text', text: `spawn error: ${e.message}` }], is_error: true })
        })
        child.on('exit', (code) => {
          ac.signal.removeEventListener('abort', abortHandler)
          if (code === 0 && existsSync(outputAbsPath)) {
            emit('artifact', { kind: 'mp4', absPath: outputAbsPath, source: 'render_remotion' })
            resolvePromise({ content: [{ type: 'text', text: `rendered to ${outputAbsPath}` }] })
          } else {
            resolvePromise({
              content: [{ type: 'text', text: `remotion exit ${code}\nstderr tail:\n${stderrTail.slice(-1200)}` }],
              is_error: true
            })
          }
        })
      })
    }
  )

  let finalized = null
  const t_finalize = tool(
    'finalize',
    'Terminate the job successfully. Call only after verifying the final mp4 exists.',
    {
      outputMp4AbsPath: z.string().describe('Absolute path to final mp4 (must exist)'),
      summary: z.string().describe('Short 1-3 sentence summary of the video: topic, style, voice, music, pipeline used')
    },
    async ({ outputMp4AbsPath, summary }) => {
      if (!isUnder(outputMp4AbsPath, workDir)) {
        return { content: [{ type: 'text', text: 'mp4 must be under job dir' }], is_error: true }
      }
      if (!existsSync(outputMp4AbsPath)) {
        return { content: [{ type: 'text', text: `file does not exist: ${outputMp4AbsPath}` }], is_error: true }
      }
      finalized = { outputMp4AbsPath, summary }
      emit('artifact', { kind: 'mp4', absPath: outputMp4AbsPath, source: 'finalize' })
      return { content: [{ type: 'text', text: 'job finalized' }] }
    }
  )

  const mcpServer = createSdkMcpServer({
    name: 'openmontage',
    version: '1.0.0',
    tools: [t_listPipelines, t_listTools, t_runTool, t_readFile, t_writeJobFile, t_renderRemotion, t_finalize]
  })

  const systemPrompt = buildSystemPrompt({ workDir, pipelineId }) + buildBranchContext(parentContext)
  const model = getModel()
  const userPrompt = `${prompt.trim()}\n\n(Pipeline hint: ${pipelineId || 'auto — pick one via list_pipelines'})`

  // Run the SDK under a process-wide mutex: the Agent SDK reads ANTHROPIC_API_KEY from
  // process.env and has no options.apiKey, so concurrent jobs would race on env mutation.
  const loopPromise = (async () => {
    const release = await acquireJobMutex()
    emit('status', 'running')

    let terminalStatus = 'error'
    let loopError = null
    let heartbeat
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY
    let keyWasSet = false

    try {
      const anthropicKey = getSecret('ANTHROPIC_API_KEY')
      if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set. Add it in Settings.')
      process.env.ANTHROPIC_API_KEY = anthropicKey
      keyWasSet = true

      heartbeat = setInterval(() => emit('status', 'running'), 5000)

      const iterator = query({
        prompt: userPrompt,
        options: {
          model,
          systemPrompt,
          mcpServers: { openmontage: mcpServer },
          allowedTools: [
            'mcp__openmontage__list_pipelines',
            'mcp__openmontage__list_tools',
            'mcp__openmontage__run_openmontage_tool',
            'mcp__openmontage__read_file',
            'mcp__openmontage__write_job_file',
            'mcp__openmontage__render_remotion',
            'mcp__openmontage__finalize'
          ],
          disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
          maxTurns: 60,
          settingSources: [],
          abortController: ac
        }
      })

      for await (const msg of iterator) {
        if (ac.signal.aborted) break
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'text' && block.text) {
              emit('agent_text', { text: block.text })
            } else if (block.type === 'tool_use') {
              emit('agent_tool_use', { name: block.name, input: truncate(block.input) })
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            emit('loop_finished', { turns: msg.num_turns ?? null })
          } else {
            emit('loop_finished', { turns: msg.num_turns ?? null, subtype: msg.subtype })
          }
        }
      }

      if (ac.signal.aborted) terminalStatus = 'cancelled'
      else if (finalized) terminalStatus = 'done'
      else terminalStatus = 'error'
    } catch (e) {
      loopError = e
      emit('log', { stream: 'agent', text: `loop error: ${e.message}` })
      terminalStatus = ac.signal.aborted ? 'cancelled' : 'error'
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      bridge.stop('SIGTERM')
      if (keyWasSet) {
        if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = previousAnthropicKey
      }

      const manifest = {
        jobId,
        createdAt: startedAt,
        finishedAt: Date.now(),
        prompt,
        pipelineId: pipelineId || null,
        parentJobId: parentContext?.parentJobId || null,
        model,
        finalized: !!finalized,
        summary: finalized?.summary || null,
        error: loopError ? loopError.message : null,
        status: terminalStatus,
        artifacts: finalized ? [{ kind: 'mp4', absPath: finalized.outputMp4AbsPath }] : []
      }
      try { writeManifest(jobId, manifest) } catch { /* best-effort */ }
      try { await refreshManifestBytes(jobId) } catch { /* best-effort */ }

      emit('status', terminalStatus)
      release()
    }
  })()

  const cancel = () => { if (!ac.signal.aborted) ac.abort() }
  return { emitter, cancel, workDir, promise: loopPromise }
}

// --- Simple chain-style mutex for ANTHROPIC_API_KEY serialization ---
let _mutexTail = Promise.resolve()
function acquireJobMutex() {
  let release
  const next = new Promise((resolvePromise) => { release = resolvePromise })
  const prior = _mutexTail
  _mutexTail = _mutexTail.then(() => next)
  return prior.then(() => release)
}
