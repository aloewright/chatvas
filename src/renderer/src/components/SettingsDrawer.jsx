import { useEffect, useState, useCallback } from 'react'
import './SettingsDrawer.css'

const PROVIDER_KEYS = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic (required)' },
  { name: 'FAL_KEY', label: 'fal.ai (FLUX, Kling, Veo, MiniMax)' },
  { name: 'RUNWAY_API_KEY', label: 'Runway' },
  { name: 'HEYGEN_API_KEY', label: 'HeyGen' },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs' },
  { name: 'SUNO_API_KEY', label: 'Suno' },
  { name: 'OPENAI_API_KEY', label: 'OpenAI (DALL-E, TTS)' },
  { name: 'GOOGLE_API_KEY', label: 'Google (Imagen, TTS)' },
  { name: 'XAI_API_KEY', label: 'xAI (Grok)' },
  { name: 'PEXELS_API_KEY', label: 'Pexels' },
  { name: 'PIXABAY_API_KEY', label: 'Pixabay' },
  { name: 'UNSPLASH_ACCESS_KEY', label: 'Unsplash' }
]

const MODELS = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (highest quality)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (faster)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (cheapest)' }
]

export default function SettingsDrawer({ onClose }) {
  const [doctor, setDoctor] = useState(null)
  const [model, setModel] = useState('claude-opus-4-7')
  const [present, setPresent] = useState({})
  const [drafts, setDrafts] = useState({})

  const refresh = useCallback(async () => {
    const d = await window.electronAPI.video.doctor()
    setDoctor(d)
    setPresent(d.secrets || {})
    setModel(d.model || 'claude-opus-4-7')
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const save = useCallback(async (name, value) => {
    await window.electronAPI.secrets.set(name, value)
    setDrafts((d) => ({ ...d, [name]: '' }))
    refresh()
  }, [refresh])

  const saveModel = useCallback(async (m) => {
    await window.electronAPI.secrets.set('__MODEL__', m)
    setModel(m)
    refresh()
  }, [refresh])

  return (
    <div className="settings-drawer-scrim" onClick={onClose}>
      <div className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <h2>
          Settings
          <button className="settings-close" onClick={onClose} aria-label="close">x</button>
        </h2>

        <div className="body">
          <h3>Account</h3>
          <AccountSection />

          <h3>System check</h3>
          {doctor ? (
            <div className="settings-doctor">
              {(() => {
                const missing = new Set(doctor.missing || [])
                const pythonOk = !missing.has('bundled-python') && !!doctor.python
                const ffmpegOk = !missing.has('ffmpeg-static') && !!doctor.ffmpeg
                return (
                  <>
                    <div className={pythonOk ? 'ok' : 'fail'}>python: {pythonOk ? doctor.python : 'not found'}</div>
                    <div className={ffmpegOk ? 'ok' : 'fail'}>ffmpeg: {ffmpegOk ? 'ok' : 'not found'}</div>
                  </>
                )
              })()}
              <div className="ok">node: {doctor.node}</div>
              <div className={doctor.submoduleReady ? 'ok' : 'fail'}>
                submodule: {doctor.submoduleReady ? 'ok' : 'run `git submodule update --init --recursive`'}
              </div>
              <div className={doctor.setupComplete ? 'ok' : 'fail'}>
                bootstrap: {doctor.setupComplete ? 'ok' : 'run `npm run setup:video`'}
              </div>
              <div className={doctor.registryError ? 'fail' : 'ok'}>
                registry: {doctor.registryError ? doctor.registryError : `${doctor.pipelineCount} pipelines, ${doctor.toolCount} tools`}
              </div>
              {doctor.secureStorage === false && (
                <div className="fail" style={{ marginTop: 4 }}>
                  warning: secret storage: plaintext (install gnome-keyring or kwallet for encryption)
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-muted)' }}>loading...</div>
          )}

          <h3>Model</h3>
          <div className="settings-row">
            <label>Orchestrator model</label>
            <select value={model} onChange={(e) => saveModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          <h3>Doppler (secret management)</h3>
          <DopplerSection onRefresh={refresh} />

          <h3>Cloudflare AI Gateway</h3>
          <CloudflareSection />

          <h3>AI Terminal</h3>
          <AiTerminalSection />

          <h3>API keys</h3>
          {PROVIDER_KEYS.map((k) => {
            const dot = present[k.name] ? <span className="saved-dot" title="saved" /> : <span className="missing-dot" title="missing" />
            return (
              <div className="settings-row" key={k.name}>
                {dot}
                <label>{k.label}</label>
                <input
                  type="password"
                  placeholder={present[k.name] ? '******* (saved)' : 'paste key'}
                  value={drafts[k.name] || ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [k.name]: e.target.value }))}
                  onBlur={(e) => { if (e.target.value) save(k.name, e.target.value) }}
                />
                {present[k.name] && (
                  <button
                    className="vs-btn secondary"
                    style={{ padding: '3px 8px', fontSize: 11 }}
                    onClick={() => save(k.name, '')}
                    title="remove key"
                  >clear</button>
                )}
              </div>
            )
          })}

          <h3>Cache</h3>
          <CacheSection />
        </div>
      </div>
    </div>
  )
}

function DopplerSection({ onRefresh }) {
  const [status, setStatus] = useState(null)
  const [token, setToken] = useState('')
  const [project, setProject] = useState('chatvas')
  const [config, setConfig] = useState('dev')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  useEffect(() => {
    window.electronAPI?.doppler?.status().then((s) => {
      setStatus(s)
      if (s?.project) setProject(s.project)
      if (s?.config) setConfig(s.config)
    })
  }, [])

  const handleSave = useCallback(async () => {
    await window.electronAPI?.doppler?.configure({ token: token || undefined, project, config })
    setToken('')
    const s = await window.electronAPI?.doppler?.status()
    setStatus(s)
    onRefresh?.()
  }, [token, project, config, onRefresh])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    const result = await window.electronAPI?.doppler?.test()
    setTestResult(result)
    setTesting(false)
  }, [])

  return (
    <div className="settings-doctor">
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        Doppler provides API keys and the Cloudflare AI Gateway URL.
        When configured, keys from Doppler override local entries.
      </div>
      <div className={status?.configured ? 'ok' : 'fail'}>
        status: {status?.configured ? 'configured' : 'not configured'}
      </div>
      <div className="settings-row" style={{ paddingLeft: 0 }}>
        <label>Service token</label>
        <input
          type="password"
          placeholder={status?.configured ? '******* (saved)' : 'dp.st.xxx...'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <div className="settings-row" style={{ paddingLeft: 0 }}>
        <label>Project</label>
        <input value={project} onChange={(e) => setProject(e.target.value)} />
      </div>
      <div className="settings-row" style={{ paddingLeft: 0 }}>
        <label>Config</label>
        <input value={config} onChange={(e) => setConfig(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="vs-btn secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={handleSave}>
          Save
        </button>
        {status?.configured && (
          <button
            className="vs-btn secondary"
            style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
        )}
      </div>
      {testResult && (
        <div className={testResult.ok ? 'ok' : 'fail'} style={{ marginTop: 4 }}>
          {testResult.ok ? `Connected (${testResult.keyCount} secrets)` : testResult.error}
        </div>
      )}
    </div>
  )
}

function CloudflareSection() {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [tokenPresent, setTokenPresent] = useState(false)
  const [saved, setSaved] = useState(false)
  const [providers, setProviders] = useState(null)

  const refresh = useCallback(async () => {
    const u = await window.electronAPI?.aiTerminal?.getCfWorkerUrl()
    if (u) setUrl(u)
    const t = await window.electronAPI?.aiTerminal?.getCfApiToken()
    setTokenPresent(!!t)
    const p = await window.electronAPI?.aiTerminal?.detectProviders()
    setProviders(p)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleSave = useCallback(async () => {
    await window.electronAPI?.aiTerminal?.setCfWorkerUrl(url)
    if (token) {
      await window.electronAPI?.aiTerminal?.setCfApiToken(token)
      setToken('')
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    await refresh()
  }, [url, token, refresh])

  const connected = providers?.cloudflare

  return (
    <div className="settings-doctor">
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        Routes prompt enhancement and video model calls through Cloudflare AI Gateway
        (gateway "x") for unified billing.
      </div>
      <div className={connected ? 'ok' : 'fail'}>
        gateway: {connected ? 'connected' : 'not connected'}
      </div>
      <div className={tokenPresent ? 'ok' : 'fail'}>
        API token: {tokenPresent ? 'saved' : 'not set'}
      </div>
      <div className="settings-row" style={{ paddingLeft: 0 }}>
        <label>Worker URL</label>
        <input
          placeholder="https://chatvas-api.your-account.workers.dev"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="settings-row" style={{ paddingLeft: 0 }}>
        <label>API token</label>
        <input
          type="password"
          placeholder={tokenPresent ? '******* (saved)' : 'cfut_...'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <button
        className="vs-btn secondary"
        style={{ fontSize: 11, padding: '4px 10px', marginTop: 4 }}
        onClick={handleSave}
      >
        {saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}

function AiTerminalSection() {
  const [providers, setProviders] = useState(null)

  useEffect(() => {
    window.electronAPI?.aiTerminal?.detectProviders().then(setProviders)
  }, [])

  return (
    <div className="settings-doctor">
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        The floating chat runs Claude Code or Codex CLI locally.
        Make sure the CLI is installed and authenticated.
      </div>
      {providers && (
        <>
          <div>Prompt enhance providers:</div>
          <div className={providers.cloudflare ? 'ok' : 'fail'}>
            cloudflare AI gateway: {providers.cloudflare ? 'available' : 'not configured'}
          </div>
          <div className={providers.anthropic ? 'ok' : 'fail'}>
            anthropic: {providers.anthropic ? 'available' : 'no key'}
          </div>
          <div className={providers.openai ? 'ok' : 'fail'}>
            openai: {providers.openai ? 'available' : 'no key'}
          </div>
        </>
      )}
    </div>
  )
}

function AccountSection() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [signingIn, setSigningIn] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true
    window.electronAPI?.auth?.getSession().then((s) => {
      if (!mounted) return
      setUser(s?.user ?? null)
      setLoading(false)
    }).catch(() => { if (mounted) setLoading(false) })

    const off = window.electronAPI?.auth?.onChanged?.((msg) => {
      setUser(msg?.user ?? null)
    })
    return () => { mounted = false; off?.() }
  }, [])

  const handleSignIn = useCallback(async (provider) => {
    setSigningIn(provider)
    setError(null)
    const res = await window.electronAPI?.auth?.signIn(provider)
    setSigningIn(null)
    if (!res?.ok) {
      setError(res?.error || 'sign-in failed')
    } else {
      setUser(res.user)
    }
  }, [])

  const handleSignOut = useCallback(async () => {
    await window.electronAPI?.auth?.signOut()
    setUser(null)
  }, [])

  if (loading) {
    return <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-muted)' }}>loading...</div>
  }

  if (user) {
    return (
      <div className="settings-doctor">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {user.image && (
            <img src={user.image} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user.name || user.email}
            </div>
            {user.name && user.email && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.email}
              </div>
            )}
          </div>
          <button
            className="vs-btn secondary"
            style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-doctor">
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        Sign in with your pdx.software account to sync settings across devices.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          className="vs-btn secondary"
          style={{ fontSize: 11, padding: '4px 10px' }}
          onClick={() => handleSignIn('google')}
          disabled={!!signingIn}
        >
          {signingIn === 'google' ? 'Opening browser...' : 'Sign in with Google'}
        </button>
        <button
          className="vs-btn secondary"
          style={{ fontSize: 11, padding: '4px 10px' }}
          onClick={() => handleSignIn('github')}
          disabled={!!signingIn}
        >
          {signingIn === 'github' ? 'Opening browser...' : 'Sign in with GitHub'}
        </button>
      </div>
      {error && <div className="fail" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  )
}

function CacheSection() {
  const [info, setInfo] = useState(null)

  const load = useCallback(async () => {
    const res = await window.electronAPI.video.listRenders()
    setInfo(res)
  }, [])
  useEffect(() => { load() }, [load])

  const gb = (b) => (b / (1024 ** 3)).toFixed(2)

  return (
    <div className="settings-doctor">
      {info ? (
        <>
          <div>renders: {info.jobs.length}</div>
          <div>total: {gb(info.totalBytes)} GB</div>
          <div style={{ marginTop: 8 }}>
            <button
              className="vs-btn secondary"
              onClick={async () => {
                const count = info?.jobs?.length ?? 0
                if (count === 0) return
                const ok = window.confirm(
                  `Delete all ${count} cached render${count === 1 ? '' : 's'} (${gb(info.totalBytes)} GB)? This cannot be undone.`
                )
                if (!ok) return
                await window.electronAPI.video.enforceQuota(0)
                load()
              }}
            >
              Clear all cached renders
            </button>
          </div>
        </>
      ) : <div>loading...</div>}
    </div>
  )
}
