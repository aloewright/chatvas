import { useCallback, useEffect, useRef, useState } from 'react'
import './BootstrapOverlay.css'

// Full-screen overlay shown on first launch while the main process installs
// OpenMontage's Python deps into the bundled Python's venv. Blocks the Video
// Studio flow until bootstrap completes; other app features (chat nodes)
// remain accessible below.

export default function BootstrapOverlay({ onDone }) {
  const [phase, setPhase] = useState('checking') // checking | idle | running | done | error
  const [step, setStep] = useState(null)
  const [log, setLog] = useState('')
  const [error, setError] = useState(null)
  const logRef = useRef(null)

  const refreshStatus = useCallback(async () => {
    const s = await window.electronAPI?.bootstrap?.status()
    if (!s) { setPhase('idle'); return s }
    if (s.done) setPhase('done')
    else if (s.running) setPhase('running')
    else if (s.error) { setPhase('error'); setError(s.error) }
    else setPhase('idle')
    return s
  }, [])

  useEffect(() => {
    refreshStatus()
    const off = window.electronAPI?.bootstrap?.onStream((msg) => {
      if (msg.type === 'step') setStep(msg.payload)
      else if (msg.type === 'log') {
        setLog((prev) => {
          const next = (prev + msg.payload).slice(-20_000)
          return next
        })
      } else if (msg.type === 'done') { setPhase('done'); onDone?.() }
      else if (msg.type === 'error') { setPhase('error'); setError(msg.payload?.message) }
    })
    return () => off?.()
  }, [refreshStatus, onDone])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const start = useCallback(async () => {
    setLog(''); setError(null); setStep(null); setPhase('running')
    await window.electronAPI.bootstrap.start()
  }, [])

  const retry = useCallback(async () => {
    setLog(''); setError(null); setStep(null); setPhase('running')
    await window.electronAPI.bootstrap.retry()
  }, [])

  if (phase === 'done' || phase === 'checking') return null

  return (
    <div className="bootstrap-scrim">
      <div className="bootstrap-modal">
        <h2>Video Studio setup</h2>
        <p className="bootstrap-sub">
          Installing Python dependencies for OpenMontage. This runs once per install
          and takes 5–10 minutes depending on your connection.
        </p>

        {phase === 'idle' && (
          <>
            <p>Ready to install.</p>
            <div className="bootstrap-actions">
              <button className="bootstrap-btn primary" onClick={start}>Install now</button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            {step?.label && (
              <div className="bootstrap-step">
                <span className="bootstrap-spinner" /> {step.label}…
              </div>
            )}
            <pre ref={logRef} className="bootstrap-log">{log || 'Starting…'}</pre>
          </>
        )}

        {phase === 'error' && (
          <>
            <div className="bootstrap-error">Setup failed: {error}</div>
            <pre ref={logRef} className="bootstrap-log">{log}</pre>
            <div className="bootstrap-actions">
              <button className="bootstrap-btn primary" onClick={retry}>Retry</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
