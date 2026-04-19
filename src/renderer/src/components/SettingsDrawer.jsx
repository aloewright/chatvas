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
          Video Studio Settings
          <button className="settings-close" onClick={onClose} aria-label="close">×</button>
        </h2>

        <div className="body">
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
                  ⚠ secret storage: plaintext (install gnome-keyring or kwallet for encryption)
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-muted)' }}>loading…</div>
          )}

          <h3>Model</h3>
          <div className="settings-row">
            <label>Orchestrator model</label>
            <select value={model} onChange={(e) => saveModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          <h3>API keys</h3>
          {PROVIDER_KEYS.map((k) => {
            const dot = present[k.name] ? <span className="saved-dot" title="saved" /> : <span className="missing-dot" title="missing" />
            return (
              <div className="settings-row" key={k.name}>
                {dot}
                <label>{k.label}</label>
                <input
                  type="password"
                  placeholder={present[k.name] ? '••••••• (saved)' : 'paste key'}
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
      ) : <div>loading…</div>}
    </div>
  )
}
