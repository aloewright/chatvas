import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, Component } from 'react'
import Markdown from 'react-markdown'
import './FloatingChat.css'

// Error boundary so a bad markdown chunk doesn't blank the whole app
class MdSafe extends Component {
  state = { err: false }
  static getDerivedStateFromError() { return { err: true } }
  render() {
    if (this.state.err) return <span>{this.props.fallback}</span>
    return this.props.children
  }
}

const PROVIDER_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  chatgpt: 'ChatGPT',
  'apple-intelligence': 'Apple Intelligence'
}

const STORAGE_KEY = 'chatvas-floating-chat'

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function persistState(lines, provider) {
  try {
    // Keep last 500 lines to avoid bloating localStorage
    const trimmed = lines.length > 500 ? lines.slice(-500) : lines
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lines: trimmed, provider }))
  } catch { /* quota exceeded — ignore */ }
}

const FloatingChat = forwardRef(function FloatingChat(_props, ref) {
  const [persisted] = useState(() => loadPersistedState())
  const [minimized, setMinimized] = useState(true)
  const [lines, setLines] = useState(persisted?.lines || [])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [provider, setProvider] = useState(persisted?.provider || 'claude-code')
  const [enhancing, setEnhancing] = useState(false)
  const [inConversation, setInConversation] = useState(false)
  const outputRef = useRef(null)
  const inputRef = useRef(null)

  useImperativeHandle(ref, () => ({
    open: () => setMinimized(false)
  }))

  // Load saved provider preference from main process
  useEffect(() => {
    window.electronAPI?.aiTerminal?.getProvider().then((p) => {
      if (p) setProvider(p)
    })
  }, [])

  // Persist lines and provider on change
  useEffect(() => {
    persistState(lines, provider)
  }, [lines, provider])

  // Subscribe to terminal output
  useEffect(() => {
    const off = window.electronAPI?.aiTerminal?.onOutput((msg) => {
      if (msg.type === 'stdout') {
        // Accumulate stdout into the last stdout line for proper markdown rendering
        setLines((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.type === 'stdout') {
            const updated = [...prev]
            updated[updated.length - 1] = { type: 'stdout', text: last.text + msg.data }
            return updated
          }
          return [...prev, { type: 'stdout', text: msg.data }]
        })
      } else if (msg.type === 'stderr') {
        setLines((prev) => {
          const next = [...prev, { type: msg.type, text: msg.data }]
          return next.length > 2000 ? next.slice(-1500) : next
        })
      } else if (msg.type === 'exit') {
        setRunning(false)
        // Only show exit message for errors — clean exit (code 0) is silent
        if (msg.code != null && msg.code !== 0) {
          setLines((prev) => [
            ...prev,
            { type: 'error', text: `Process exited with code ${msg.code}` }
          ])
        }
      } else if (msg.type === 'started') {
        setRunning(true)
      } else if (msg.type === 'system') {
        setLines((prev) => [
          ...prev,
          { type: 'system', text: msg.data }
        ])
      } else if (msg.type === 'error') {
        setRunning(false)
        setLines((prev) => [
          ...prev,
          { type: 'error', text: msg.data }
        ])
      }
    })
    return () => off?.()
  }, [provider])

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [lines])

  // Focus input when expanded
  useEffect(() => {
    if (!minimized && inputRef.current) {
      inputRef.current.focus()
    }
  }, [minimized])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    setLines((prev) => [...prev, { type: 'user', text }])

    if (!inConversation) {
      // First message — start a new session
      setInConversation(true)
      await window.electronAPI?.aiTerminal?.start(provider, text)
    } else {
      // Follow-up — sends via write which spawns a --continue
      await window.electronAPI?.aiTerminal?.write(text)
    }
  }, [input, inConversation, provider])

  const handleStop = useCallback(async () => {
    await window.electronAPI?.aiTerminal?.stop()
    setInConversation(false)
  }, [])

  const handleProviderChange = useCallback(async (p) => {
    setProvider(p)
    await window.electronAPI?.aiTerminal?.setProvider(p)
    await window.electronAPI?.aiTerminal?.stop()
    setInConversation(false)
  }, [])

  const handleClear = useCallback(async () => {
    setLines([])
    setInConversation(false)
    await window.electronAPI?.aiTerminal?.stop()
  }, [])

  const handleEnhance = useCallback(async () => {
    setEnhancing(true)
    try {
      const result = await window.electronAPI?.aiTerminal?.enhancePrompt(input, provider)
      if (result?.enhanced) {
        setInput(result.enhanced)
        setLines((prev) => [
          ...prev,
          { type: 'system', text: `--- prompt enhanced via ${result.provider} ---` }
        ])
      } else if (result?.error) {
        setLines((prev) => [
          ...prev,
          { type: 'error', text: result.error }
        ])
      }
    } catch (err) {
      setLines((prev) => [
        ...prev,
        { type: 'error', text: `Enhance failed: ${err.message}` }
      ])
    } finally {
      setEnhancing(false)
    }
  }, [input, provider])

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  // Minimized pill
  if (minimized) {
    return (
      <button
        className="floating-chat-pill"
        onClick={() => setMinimized(false)}
        title="Open AI Terminal"
      >
        <span className="pill-icon">&gt;_</span>
        <span className="pill-label">{PROVIDER_LABELS[provider]}</span>
        {running && <span className="pill-running" />}
      </button>
    )
  }

  return (
    <div className="floating-chat">
      {/* Header */}
      <div className="fc-header">
        <div className="fc-header-left">
          <select
            className="fc-provider-select"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="apple-intelligence">Apple Intelligence</option>
          </select>
          {running && <span className="fc-status-dot" title="Running" />}
        </div>
        <div className="fc-header-right">
          {running && (
            <button className="fc-btn fc-stop-btn" onClick={handleStop} title="Stop">
              Stop
            </button>
          )}
          <button className="fc-btn" onClick={handleClear} title="Clear output">
            Clear
          </button>
          <button
            className="fc-btn fc-minimize-btn"
            onClick={() => setMinimized(true)}
            title="Minimize"
          >
            &minus;
          </button>
        </div>
      </div>

      {/* Output */}
      <div className="fc-output" ref={outputRef}>
        {lines.length === 0 && (
          <div className="fc-placeholder">
            Type a prompt to start a {PROVIDER_LABELS[provider]} session.
            <br />
            Use the sparkle button to enhance your prompt with AI.
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={`fc-line fc-line-${line.type}`}>
            {line.type === 'user' && <span className="fc-prompt-marker">&gt; </span>}
            {line.type === 'stdout' ? (
              <MdSafe fallback={line.text}>
                <Markdown className="fc-markdown">{line.text}</Markdown>
              </MdSafe>
            ) : (
              line.text
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="fc-input-row">
        <button
          className="fc-enhance-btn"
          onClick={handleEnhance}
          disabled={enhancing}
          title="Enhance prompt with AI"
        >
          {enhancing ? '...' : '*'}
        </button>
        <input
          ref={inputRef}
          className="fc-input"
          type="text"
          placeholder={inConversation ? 'Follow up...' : 'Enter prompt...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="fc-send-btn" onClick={handleSend} disabled={!input.trim() || running}>
          {running ? '...' : inConversation ? 'Send' : 'Run'}
        </button>
      </div>
    </div>
  )
})

export default FloatingChat
