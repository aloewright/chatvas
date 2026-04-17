import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import useVideoJob from '../hooks/useVideoJob'
import './VideoNode.css'

function VideoNode({ id, data }) {
  const [pipelines, setPipelines] = useState([])
  const [pipelineId, setPipelineId] = useState('')
  const [prompt, setPrompt] = useState(data.initialPrompt || '')
  const [tab, setTab] = useState('prompt')
  const textareaRef = useRef(null)
  const job = useVideoJob()

  const parentContext = data.parentContext || null

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.video.listPipelines().then((res) => {
      if (cancelled) return
      setPipelines(res.pipelines || [])
    }).catch(() => { /* silent; user hits doctor */ })
    return () => { cancelled = true }
  }, [])

  const mp4Artifact = useMemo(() => {
    return [...job.artifacts].reverse().find((a) => a.kind === 'mp4')
  }, [job.artifacts])

  useEffect(() => {
    if (mp4Artifact && tab === 'stream') setTab('output')
  }, [mp4Artifact, tab])

  const onSubmit = useCallback(async () => {
    if (!prompt.trim()) return
    setTab('stream')
    await job.start({ nodeId: id, prompt, pipelineId: pipelineId || null, parentContext })
  }, [prompt, pipelineId, parentContext, id, job])

  const onKeyDown = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onSubmit()
    }
  }, [onSubmit])

  const onBranch = useCallback(() => {
    if (!data.onBranch) return
    const summary = [...job.events]
      .reverse()
      .find((e) => e.type === 'log' && typeof e.payload?.text === 'string' && e.payload.text.startsWith('loop finished'))
      ? 'Completed'
      : (job.artifacts.find((a) => a.source === 'finalize') ? 'Finalized' : 'In progress')
    data.onBranch({
      kind: 'video',
      parentJobId: job.jobId,
      parentPrompt: prompt,
      parentSummary: summary
    }, id)
  }, [data, job.jobId, job.events, job.artifacts, prompt, id])

  const statusLabel = {
    idle: 'idle',
    running: 'running',
    done: 'done',
    error: 'error',
    cancelled: 'cancelled'
  }[job.status] || job.status

  return (
    <div className="video-node">
      <Handle type="target" position={Position.Left} className="chat-handle" />

      <div className="video-node-header">
        <span className="video-node-title">🎬 Video Studio · {pipelineId || 'auto'}</span>
        <span className={`video-node-status ${job.status}`}>{statusLabel}</span>
        <button className="close-btn" title="Close node" onClick={() => data.onClose?.(id)}>×</button>
      </div>

      <div className="video-node-toolbar">
        <select
          value={pipelineId}
          onChange={(e) => setPipelineId(e.target.value)}
          disabled={job.status === 'running'}
        >
          <option value="">auto (agent picks)</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          className="vs-btn"
          onClick={onSubmit}
          disabled={!prompt.trim() || job.status === 'running'}
          title="Cmd/Ctrl+Enter"
        >
          Generate
        </button>
        {job.status === 'running' && (
          <button className="vs-btn danger" onClick={job.cancel}>Cancel</button>
        )}
        {(job.status === 'done' || mp4Artifact) && (
          <button className="vs-btn secondary" onClick={onBranch}>Branch with alternate style</button>
        )}
        {job.progress != null && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            render {job.progress}%
          </span>
        )}
      </div>

      <div className="video-node-tabs">
        <button className={`video-node-tab ${tab === 'prompt' ? 'active' : ''}`} onClick={() => setTab('prompt')}>Prompt</button>
        <button className={`video-node-tab ${tab === 'stream' ? 'active' : ''}`} onClick={() => setTab('stream')}>Stream</button>
        <button className={`video-node-tab ${tab === 'output' ? 'active' : ''}`} onClick={() => setTab('output')}>Output</button>
      </div>

      <div className="video-node-body">
        {tab === 'prompt' && (
          <>
            {parentContext && (
              <div className="video-node-parent-chip">
                <div><b>Branched from:</b> {parentContext.parentJobId}</div>
                <div style={{ marginTop: 4 }}><b>Parent prompt:</b> {parentContext.parentPrompt}</div>
                {parentContext.parentSummary && (
                  <div style={{ marginTop: 4 }}><b>Parent state:</b> {parentContext.parentSummary}</div>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              placeholder="Describe the video you want — topic, length, style, voice, mood. Cmd/Ctrl+Enter to submit."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={job.status === 'running'}
            />
          </>
        )}

        {tab === 'stream' && (
          <div className="video-node-stream">
            {job.progress != null && (
              <div className="vs-progress-bar"><div className="vs-progress-fill" style={{ width: `${job.progress}%` }} /></div>
            )}
            {job.events.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No events yet. Hit Generate on the Prompt tab.</div>}
            {job.events.map((e, i) => (
              <div key={i} className={`vs-event ${e.type}`}>
                {renderEvent(e)}
              </div>
            ))}
          </div>
        )}

        {tab === 'output' && (
          <div className="video-node-output">
            {mp4Artifact ? (
              <>
                <video controls src={`file://${mp4Artifact.absPath}`} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="vs-btn secondary" onClick={job.openFolder}>Open in folder</button>
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  {mp4Artifact.absPath}
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)' }}>
                No rendered video yet. When the agent calls <code>finalize</code> the MP4 will appear here.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="video-node-footer">
        {job.jobId ? (
          <code
            title="Click to copy job id"
            onClick={() => job.jobId && navigator.clipboard?.writeText(job.jobId)}
          >{job.jobId}</code>
        ) : <span>no job</span>}
        {job.error && <span style={{ color: '#e5484d' }}>error: {job.error}</span>}
      </div>

      <Handle type="source" position={Position.Right} className="chat-handle" />
    </div>
  )
}

function renderEvent(e) {
  const p = e.payload
  switch (e.type) {
    case 'agent_text':
      return p?.text || ''
    case 'tool_call_start':
      return `→ ${p.tool}(${JSON.stringify(p.args).slice(0, 200)})`
    case 'tool_call_end':
      return p.ok
        ? `✓ ${p.tool}`
        : `✗ ${p.tool}: ${p.error || 'failed'}`
    case 'render_progress':
      return `render ${p.pct}%${p.message ? ` — ${p.message}` : ''}`
    case 'status':
      return `[status] ${p}`
    case 'artifact':
      return `📎 ${p.kind} ${p.absPath}`
    case 'log':
      return (p?.text || '').trim()
    case 'agent_tool_use':
      return `[sdk] ${p.name}(${JSON.stringify(p.input).slice(0, 120)})`
    default:
      return JSON.stringify(p)
  }
}

export default VideoNode
