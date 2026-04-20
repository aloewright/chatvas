import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_EVENTS = 500

// Drives a single Video Studio job: submit prompt → subscribe to stream → expose status/events/artifacts.
export default function useVideoJob() {
  const [jobId, setJobId] = useState(null)
  const [status, setStatus] = useState('idle') // idle | running | done | error | cancelled
  const [events, setEvents] = useState([])
  const [artifacts, setArtifacts] = useState([])
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const unsubRef = useRef(null)

  const cleanup = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current()
      unsubRef.current = null
    }
  }, [])

  useEffect(() => cleanup, [cleanup])

  const start = useCallback(async ({ nodeId, prompt, pipelineId, parentContext }) => {
    setEvents([])
    setArtifacts([])
    setProgress(null)
    setError(null)
    setStatus('running')

    try {
      const res = await window.electronAPI.video.start({ nodeId, prompt, pipelineId, parentContext })
      setJobId(res.jobId)
      cleanup()
      unsubRef.current = window.electronAPI.video.onStream(res.jobId, (msg) => {
        setEvents((prev) => {
          const next = [...prev, msg]
          if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS)
          return next
        })
        if (msg.type === 'status' && typeof msg.payload === 'string') {
          setStatus(msg.payload)
        }
        if (msg.type === 'render_progress' && typeof msg.payload?.pct === 'number') {
          setProgress(msg.payload.pct)
        }
        if (msg.type === 'artifact') {
          setArtifacts((prev) => [...prev, msg.payload])
        }
      })
      return res.jobId
    } catch (e) {
      setError(e.message)
      setStatus('error')
      return null
    }
  }, [cleanup])

  const cancel = useCallback(async () => {
    if (!jobId) return
    await window.electronAPI.video.cancel(jobId)
  }, [jobId])

  const openFolder = useCallback(() => {
    if (!jobId) return
    window.electronAPI.video.openArtifact(jobId, null)
  }, [jobId])

  return { jobId, status, events, artifacts, progress, error, start, cancel, openFolder }
}
