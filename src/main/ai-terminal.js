import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { getSecret, setSecret } from './secrets.js'
import { enhancePrompt, detectProviders, resolveWorkerUrl } from './prompt-enhance.js'
import { resolveSecret, isDopplerConfigured, getDopplerConfig, setDopplerConfig, fetchDopplerSecrets } from './doppler.js'
import treeKill from 'tree-kill'

const PROVIDER_KEY = '__AI_TERMINAL_PROVIDER__'

// Whitelist of accepted providers. Values are the shell command to spawn,
// or null for HTTP-only providers. Used to prevent arbitrary command
// execution from an attacker-controlled provider string.
const PROVIDERS = Object.freeze({
  'claude-code':          'claude',
  'codex':                'codex',
  'apple-intelligence':   'swift',
  'chatgpt':              null
})

const DEFAULT_PROVIDER = 'claude-code'

function isValidProvider(p) {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, p)
}

let activeProcess = null
let activeConversationId = null
let pendingPrompt = null       // queued follow-up while a process is running
let mainWindowGetter = null

function send(channel, data) {
  try {
    const win = mainWindowGetter?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  } catch (e) {
    console.warn('[ai-terminal] failed to send to renderer:', e?.message)
  }
}

function killActive() {
  return new Promise((resolve) => {
    if (!activeProcess) return resolve()
    const proc = activeProcess
    activeProcess = null
    try {
      treeKill(proc.pid, 'SIGTERM', () => resolve())
    } catch (e) {
      console.warn('[ai-terminal] SIGTERM failed:', e?.message)
      resolve()
    }
    setTimeout(() => {
      try { treeKill(proc.pid, 'SIGKILL') } catch (e) {
        console.warn('[ai-terminal] SIGKILL failed:', e?.message)
      }
      resolve()
    }, 3000)
  })
}

export function registerAiTerminalIpc({ getMainWindow }) {
  mainWindowGetter = getMainWindow

  // --- AI Terminal ---
  ipcMain.handle('ai-terminal:getProvider', () => {
    const stored = getSecret(PROVIDER_KEY)
    return isValidProvider(stored) ? stored : DEFAULT_PROVIDER
  })

  ipcMain.handle('ai-terminal:setProvider', (_e, provider) => {
    if (!isValidProvider(provider)) {
      throw new Error(`Unknown provider: ${provider}`)
    }
    setSecret(PROVIDER_KEY, provider)
  })

  ipcMain.handle('ai-terminal:start', async (_e, provider, prompt) => {
    if (!isValidProvider(provider)) {
      send('ai-terminal:output', { type: 'error', data: `Unknown provider: ${provider}` })
      return { ok: false, error: 'invalid-provider' }
    }
    await killActive()
    pendingPrompt = null
    activeConversationId = null
    runPrompt(provider, prompt)
    return { ok: true }
  })

  ipcMain.handle('ai-terminal:write', async (_e, text) => {
    const trimmed = text.trim()
    if (!trimmed) return false

    const stored = getSecret(PROVIDER_KEY)
    const provider = isValidProvider(stored) ? stored : DEFAULT_PROVIDER

    if (activeProcess) {
      // A process is still running — queue this as the next prompt
      pendingPrompt = { provider, prompt: trimmed }
      send('ai-terminal:output', {
        type: 'system',
        data: '(waiting for current response to finish...)'
      })
      return { ok: true, queued: true }
    }

    // No active process — run immediately
    runPrompt(provider, trimmed)
    return { ok: true }
  })

  ipcMain.handle('ai-terminal:stop', async () => {
    pendingPrompt = null
    await killActive()
    activeConversationId = null
    return true
  })

  function runPrompt(provider, prompt) {
    if (!isValidProvider(provider)) {
      send('ai-terminal:output', { type: 'error', data: `Unknown provider: ${provider}` })
      return
    }

    // ChatGPT is HTTP-only; no child process.
    if (provider === 'chatgpt') return runChatGPT(prompt)

    const cmd = PROVIDERS[provider]
    let args

    if (provider === 'codex') {
      args = ['--quiet', prompt]
    } else if (provider === 'apple-intelligence') {
      // Apple Intelligence via the macOS `swift` command running a Foundation Models prompt.
      // Uses the built-in on-device model — no API key needed.
      args = [
        '-e',
        `import FoundationModels; let session = LanguageModelSession(); let resp = try await session.respond(to: "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"); print(resp.content)`
      ]
    } else {
      // claude-code (default)
      args = ['--print', '--output-format', 'text']
      if (activeConversationId) {
        args.push('--continue', activeConversationId)
      }
      args.push(prompt)
    }

    try {
      const proc = spawn(cmd, args, {
        env: { ...process.env, FORCE_COLOR: '0' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']  // ignore stdin — prompt is in args
      })

      activeProcess = proc
      send('ai-terminal:output', { type: 'started', provider })

      let stderrBuf = ''

      proc.stdout.on('data', (chunk) => {
        send('ai-terminal:output', { type: 'stdout', data: chunk.toString() })
      })

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        stderrBuf += text
        // Capture conversation ID from stderr
        const match = text.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)
        if (match && !activeConversationId) {
          activeConversationId = match[1]
        }
        // Don't forward the stdin warning — it's noise
        if (!text.includes('no stdin data received')) {
          send('ai-terminal:output', { type: 'stderr', data: text })
        }
      })

      proc.on('error', (err) => {
        send('ai-terminal:output', {
          type: 'error',
          data: `Failed to start "${cmd}": ${err.message}\nMake sure ${cmd} is installed and on your PATH.`
        })
        activeProcess = null
      })

      proc.on('close', (code) => {
        if (activeProcess === proc) activeProcess = null

        // Try to capture conversation ID from stderr if not found yet
        if (!activeConversationId) {
          const match = stderrBuf.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)
          if (match) activeConversationId = match[1]
        }

        // Only show exit if it was an error — normal completion (0) is silent
        if (code !== 0) {
          send('ai-terminal:output', { type: 'exit', code })
        }

        // If there's a queued follow-up, run it now
        if (pendingPrompt) {
          const { provider: p, prompt: pr } = pendingPrompt
          pendingPrompt = null
          runPrompt(p, pr)
        }
      })
    } catch (err) {
      send('ai-terminal:output', {
        type: 'error',
        data: `Failed to start "${cmd}": ${err.message}`
      })
    }
  }

  // ChatGPT via Cloudflare AI Gateway or direct OpenAI API
  async function runChatGPT(prompt) {
    send('ai-terminal:output', { type: 'started', provider: 'chatgpt' })

    try {
      // Resolve the gateway URL and API key
      const workerUrl = await resolveWorkerUrl()
      const openaiKey = await resolveSecret('OPENAI_API_KEY')

      let apiUrl, headers

      if (workerUrl) {
        // Route through Cloudflare AI Gateway
        apiUrl = `${workerUrl}/api/ai/openai`
        const cfToken = await resolveSecret('__CF_API_TOKEN__')
        headers = { 'Content-Type': 'application/json' }
        if (cfToken) headers['cf-aig-authorization'] = `Bearer ${cfToken}`
        if (openaiKey) headers['Authorization'] = `Bearer ${openaiKey}`
      } else if (openaiKey) {
        // Direct OpenAI API
        apiUrl = 'https://api.openai.com/v1/chat/completions'
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        }
      } else {
        send('ai-terminal:output', {
          type: 'error',
          data: 'ChatGPT requires an OpenAI API key or a Cloudflare AI Gateway URL. Configure one in Settings.'
        })
        return { ok: false }
      }

      // Build messages — include conversation history if we have a conversation ID
      const messages = [
        { role: 'system', content: 'You are a helpful coding assistant. Respond concisely.' },
        { role: 'user', content: prompt }
      ]

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'chatgpt-4o-latest',
          messages,
          stream: false
        })
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        send('ai-terminal:output', {
          type: 'error',
          data: `ChatGPT API error ${res.status}: ${errText}`
        })
        return { ok: false }
      }

      const data = await res.json()
      const reply = data?.choices?.[0]?.message?.content
        || data?.response
        || data?.result?.response
        || JSON.stringify(data)

      send('ai-terminal:output', { type: 'stdout', data: reply })

      // If there's a queued follow-up, run it now
      if (pendingPrompt) {
        const { provider: p, prompt: pr } = pendingPrompt
        pendingPrompt = null
        runPrompt(p, pr)
      }

      return { ok: true }
    } catch (err) {
      send('ai-terminal:output', {
        type: 'error',
        data: `ChatGPT request failed: ${err.message}`
      })
      return { ok: false }
    }
  }

  // --- Prompt Enhancement ---
  ipcMain.handle('ai-terminal:enhancePrompt', async (_e, rawPrompt, platform) => {
    return enhancePrompt(rawPrompt, platform)
  })

  ipcMain.handle('ai-terminal:detectProviders', async () => {
    return detectProviders()
  })

  // --- Doppler ---
  ipcMain.handle('doppler:status', () => {
    return {
      configured: isDopplerConfigured(),
      ...getDopplerConfig()
    }
  })

  ipcMain.handle('doppler:configure', (_e, config) => {
    setDopplerConfig(config)
    return { ok: true }
  })

  ipcMain.handle('doppler:test', async () => {
    const secrets = await fetchDopplerSecrets(true)
    if (!secrets) return { ok: false, error: 'Could not reach Doppler. Check your service token.' }
    return { ok: true, keyCount: Object.keys(secrets).length }
  })

  // --- Cloudflare Worker URL ---
  ipcMain.handle('ai-terminal:getCfWorkerUrl', async () => {
    return (await resolveSecret('__CF_WORKER_URL__')) || ''
  })

  ipcMain.handle('ai-terminal:setCfWorkerUrl', (_e, url) => {
    setSecret('__CF_WORKER_URL__', url)
    return { ok: true }
  })

  ipcMain.handle('ai-terminal:getCfApiToken', async () => {
    return (await resolveSecret('__CF_API_TOKEN__')) ? '(saved)' : ''
  })

  ipcMain.handle('ai-terminal:setCfApiToken', (_e, token) => {
    setSecret('__CF_API_TOKEN__', token)
    return { ok: true }
  })
}
