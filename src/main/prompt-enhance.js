/**
 * Prompt enhancement — takes a raw prompt (possibly blank) and uses an
 * available AI provider to rewrite it into a well-formatted prompt for the
 * target platform (Claude Code or Codex).
 *
 * Provider priority:
 *   1. Cloudflare AI Gateway (free Workers AI models, no key needed if worker is deployed)
 *   2. Anthropic API (if ANTHROPIC_API_KEY is set)
 *   3. OpenAI API (if OPENAI_API_KEY is set)
 */

import { resolveSecret, isDopplerConfigured, fetchDopplerSecrets, resolveSecretSync } from './doppler.js'
import { getSecret } from './secrets.js'

const SYSTEM_PROMPTS = {
  'claude-code': `You are a prompt formatting assistant. Your job is to take a user's rough idea (which may be blank, vague, or detailed) and rewrite it as an effective prompt for Claude Code — Anthropic's CLI agent for software engineering.

Rules for the output prompt:
- Be specific about what files, functions, or features to work on
- Include any relevant context about the project or codebase
- Specify the desired outcome clearly
- Use imperative language ("Create...", "Fix...", "Refactor...")
- If the input is blank, generate a helpful starting prompt that asks Claude Code to analyze the current project and suggest improvements
- Keep it concise but complete — 1-4 sentences
- Do NOT include markdown formatting or code blocks — just the plain prompt text
- Do NOT explain what you're doing — just output the enhanced prompt`,

  codex: `You are a prompt formatting assistant. Your job is to take a user's rough idea (which may be blank, vague, or detailed) and rewrite it as an effective prompt for OpenAI Codex CLI — a coding agent.

Rules for the output prompt:
- Be specific about what files, functions, or features to work on
- Include any relevant context about the project or codebase
- Specify the desired outcome clearly
- Use imperative language ("Create...", "Fix...", "Refactor...")
- If the input is blank, generate a helpful starting prompt that asks Codex to analyze the current project and suggest improvements
- Keep it concise but complete — 1-4 sentences
- Do NOT include markdown formatting or code blocks — just the plain prompt text
- Do NOT explain what you're doing — just output the enhanced prompt`,

  video: `You are a prompt formatting assistant for an AI video generation studio (OpenMontage). Your job is to take a user's rough idea (which may be blank, vague, or detailed) and rewrite it as an effective video generation prompt.

Rules for the output prompt:
- Describe the video concept clearly: topic, visual style, mood, pacing
- Suggest a duration if not specified (15s, 30s, 60s, 90s)
- Include details about: visual aesthetic (cinematic, anime, documentary, etc.), camera work (tracking shots, close-ups, aerial), music/sound style, narration tone
- If the input is blank, generate an interesting demo video concept (e.g. a nature documentary opener, a product showcase, a music video)
- Keep it to 2-5 sentences — detailed enough to guide generation, concise enough to be clear
- Do NOT include markdown formatting or code blocks — just the plain prompt text
- Do NOT explain what you're doing — just output the enhanced prompt`,

  chatgpt: `You are a prompt formatting assistant. Your job is to take a user's rough idea (which may be blank, vague, or detailed) and rewrite it as an effective prompt for ChatGPT — OpenAI's conversational AI.

Rules for the output prompt:
- Be specific about what you want ChatGPT to help with
- Include relevant context and constraints
- Specify the desired format of the response if applicable
- If the input is blank, generate a helpful starting prompt
- Keep it concise but complete — 1-4 sentences
- Do NOT include markdown formatting or code blocks — just the plain prompt text
- Do NOT explain what you're doing — just output the enhanced prompt`,

  'apple-intelligence': `You are a prompt formatting assistant. Your job is to take a user's rough idea (which may be blank, vague, or detailed) and rewrite it as an effective prompt for Apple Intelligence — Apple's on-device AI running via Foundation Models on macOS.

Rules for the output prompt:
- Keep prompts concise — on-device models work best with clear, focused requests
- Be specific about the task: summarize, rewrite, generate, explain
- Apple Intelligence excels at text tasks: writing, summarization, extraction
- If the input is blank, generate a simple helpful prompt (e.g. summarize, draft an email, explain a concept)
- Keep it to 1-3 sentences
- Do NOT include markdown formatting or code blocks — just the plain prompt text
- Do NOT explain what you're doing — just output the enhanced prompt`
}

async function getSecretAsync(name) {
  return await resolveSecret(name)
}

/**
 * Try Cloudflare AI Gateway first (via the deployed worker).
 */
async function tryCloudflareAI(userPrompt, platform, workerUrl) {
  if (!workerUrl) return null

  try {
    const cfToken = await getSecretAsync('__CF_API_TOKEN__') || getSecret('__CF_API_TOKEN__')
    const headers = { 'Content-Type': 'application/json' }
    if (cfToken) headers['Authorization'] = `Bearer ${cfToken}`

    const res = await fetch(`${workerUrl}/api/ai/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS[platform] },
          { role: 'user', content: userPrompt || '(blank — the user left the prompt empty, generate a good starting prompt)' }
        ]
      })
    })

    if (!res.ok) return null
    const data = await res.json()
    const text = data?.response || data?.result?.response
    return text?.trim() || null
  } catch {
    return null
  }
}

/**
 * Try Anthropic API.
 */
async function tryAnthropic(userPrompt, platform) {
  const key = await getSecretAsync('ANTHROPIC_API_KEY')
  if (!key) return null

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPTS[platform],
        messages: [
          { role: 'user', content: userPrompt || '(blank — the user left the prompt empty, generate a good starting prompt)' }
        ]
      })
    })

    if (!res.ok) return null
    const data = await res.json()
    return data?.content?.[0]?.text?.trim() || null
  } catch {
    return null
  }
}

/**
 * Try OpenAI API.
 */
async function tryOpenAI(userPrompt, platform) {
  const key = await getSecretAsync('OPENAI_API_KEY')
  if (!key) return null

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS[platform] },
          { role: 'user', content: userPrompt || '(blank — the user left the prompt empty, generate a good starting prompt)' }
        ]
      })
    })

    if (!res.ok) return null
    const data = await res.json()
    return data?.choices?.[0]?.message?.content?.trim() || null
  } catch {
    return null
  }
}

/**
 * Resolve the Cloudflare Worker URL — checks Doppler (AI_GATEWAY_URL or
 * CF_WORKER_URL), then falls back to the local __CF_WORKER_URL__ setting.
 */
export async function resolveWorkerUrl() {
  // Try Doppler first
  if (isDopplerConfigured()) {
    const secrets = await fetchDopplerSecrets()
    if (secrets) {
      // Common Doppler key names for the gateway
      const url = secrets.AI_GATEWAY_URL || secrets.CF_WORKER_URL || secrets.CLOUDFLARE_WORKER_URL
      if (url) return url
    }
  }
  return getSecret('__CF_WORKER_URL__') || null
}

/**
 * Detect which providers are available.
 */
export async function detectProviders() {
  const anthropicKey = await getSecretAsync('ANTHROPIC_API_KEY')
  const openaiKey = await getSecretAsync('OPENAI_API_KEY')
  const workerUrl = await resolveWorkerUrl()

  return {
    cloudflare: !!workerUrl,
    anthropic: !!anthropicKey,
    openai: !!openaiKey,
    any: !!(workerUrl || anthropicKey || openaiKey)
  }
}

/**
 * Enhance a prompt for the target platform. Tries providers in priority order.
 * Returns { enhanced: string, provider: string } or { error: string }.
 */
export async function enhancePrompt(userPrompt, platform) {
  const workerUrl = await resolveWorkerUrl()

  // 1. Cloudflare AI Gateway
  const cfResult = await tryCloudflareAI(userPrompt, platform, workerUrl)
  if (cfResult) return { enhanced: cfResult, provider: 'cloudflare' }

  // 2. Anthropic
  const anthropicResult = await tryAnthropic(userPrompt, platform)
  if (anthropicResult) return { enhanced: anthropicResult, provider: 'anthropic' }

  // 3. OpenAI
  const openaiResult = await tryOpenAI(userPrompt, platform)
  if (openaiResult) return { enhanced: openaiResult, provider: 'openai' }

  return { error: 'No AI provider available. Add an API key in Settings or configure a Cloudflare Worker URL.' }
}
