import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ChatNode from './components/ChatNode'
import VideoNode from './components/VideoNode'
import SettingsDrawer from './components/SettingsDrawer'
import themes from './themes'

let nodeIdCounter = 1
const getNextNodeId = () => `node-${++nodeIdCounter}`

// Swatch preview colors (the canvas bg for each theme)
const swatchColors = {
  midnight: '#0f0f1a',
  nord: '#2e3440',
  rosePine: '#191724',
  solarizedDark: '#002b36',
  light: '#f5f5f5'
}

function App() {
  // --- Theme state ---
  const [themeName, setThemeName] = useState('midnight')
  const theme = themes[themeName]
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    for (const [key, value] of Object.entries(theme)) {
      if (key.startsWith('--')) {
        root.style.setProperty(key, value)
      }
    }
  }, [theme])

  // --- Webview <-> Node mapping ---
  const webContentsMapRef = useRef(new Map())

  const registerWebview = useCallback((nodeId, wcId) => {
    webContentsMapRef.current.set(wcId, nodeId)
  }, [])

  const unregisterWebview = useCallback((nodeId) => {
    for (const [wcId, nId] of webContentsMapRef.current.entries()) {
      if (nId === nodeId) {
        webContentsMapRef.current.delete(wcId)
      }
    }
  }, [])

  // Stable refs
  const handleBranchRef = useRef(null)
  const handleCloseRef = useRef(null)

  const onBranchStable = useCallback(
    (payload, sourceNodeId) => handleBranchRef.current?.(payload, sourceNodeId),
    []
  )
  const onCloseStable = useCallback(
    (nodeId) => handleCloseRef.current?.(nodeId),
    []
  )

  // --- React Flow state ---
  const [nodes, setNodes, onNodesChange] = useNodesState([
    {
      id: 'node-1',
      type: 'chatNode',
      position: { x: 0, y: 0 },
      data: {
        url: 'https://chatgpt.com',
        label: 'ChatGPT',
        registerWebview,
        unregisterWebview,
        onBranch: (payload, sourceNodeId) => handleBranchRef.current?.(payload, sourceNodeId),
        onClose: (nodeId) => handleCloseRef.current?.(nodeId)
      },
      dragHandle: '.chat-node-header'
    }
  ])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  const nodeTypes = useMemo(() => ({ chatNode: ChatNode, videoNode: VideoNode }), [])

  const handleClose = useCallback(
    (nodeId) => {
      unregisterWebview(nodeId)
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    },
    [unregisterWebview, setNodes, setEdges]
  )
  handleCloseRef.current = handleClose

  // --- Branch handler (dispatches on payload.kind) ---
  const handleBranch = useCallback(
    (payload, sourceNodeId) => {
      // Back-compat: old callers pass (url, sourceNodeId)
      if (typeof payload === 'string') {
        payload = { kind: 'chat', url: payload }
      }
      const newId = getNextNodeId()

      setNodes((currentNodes) => {
        const sourceNode = currentNodes.find((n) => n.id === sourceNodeId)
        const baseX = sourceNode ? sourceNode.position.x : 0
        const baseY = sourceNode ? sourceNode.position.y : 0
        const pos = {
          x: baseX + 720,
          y: baseY + Math.random() * 300 - 150
        }

        let node
        if (payload.kind === 'video') {
          node = {
            id: newId,
            type: 'videoNode',
            position: pos,
            data: {
              parentContext: {
                parentJobId: payload.parentJobId,
                parentPrompt: payload.parentPrompt,
                parentSummary: payload.parentSummary
              },
              initialPrompt: '',
              registerWebview,
              unregisterWebview,
              onBranch: onBranchStable,
              onClose: onCloseStable
            },
            dragHandle: '.video-node-header'
          }
        } else {
          // chat branch — default path
          node = {
            id: newId,
            type: 'chatNode',
            position: pos,
            data: {
              url: payload.url,
              label: `Branch from ${sourceNodeId}`,
              registerWebview,
              unregisterWebview,
              onBranch: onBranchStable,
              onClose: onCloseStable
            },
            dragHandle: '.chat-node-header'
          }
        }

        return [...currentNodes, node]
      })

      if (sourceNodeId) {
        setEdges((currentEdges) => [
          ...currentEdges,
          {
            id: `edge-${sourceNodeId}-${newId}`,
            source: sourceNodeId,
            target: newId,
            animated: true,
            style: { stroke: 'var(--accent)', strokeWidth: 2 }
          }
        ])
      }

      return newId
    },
    [registerWebview, unregisterWebview, onBranchStable, onCloseStable, setNodes, setEdges]
  )
  handleBranchRef.current = handleBranch

  // --- IPC: branch events from webview new-window path ---
  useEffect(() => {
    if (!window.electronAPI) return

    window.electronAPI.onNewBranch(({ url, sourceWebContentsId }) => {
      const sourceNodeId = webContentsMapRef.current.get(sourceWebContentsId)
      handleBranch({ kind: 'chat', url }, sourceNodeId || 'node-1')
    })

    return () => {
      if (window.electronAPI) {
        window.electronAPI.removeNewBranchListener()
      }
    }
  }, [handleBranch])

  const handleAddRootChatNode = useCallback(() => {
    const newId = getNextNodeId()
    setNodes((nds) => [
      ...nds,
      {
        id: newId,
        type: 'chatNode',
        position: {
          x: Math.random() * 800 - 400,
          y: Math.random() * 600 - 300
        },
        data: {
          url: 'https://chatgpt.com',
          label: 'New Chat',
          registerWebview,
          unregisterWebview,
          onBranch: onBranchStable,
          onClose: onCloseStable
        },
        dragHandle: '.chat-node-header'
      }
    ])
  }, [registerWebview, unregisterWebview, onBranchStable, onCloseStable, setNodes])

  const handleAddRootVideoNode = useCallback(() => {
    const newId = getNextNodeId()
    setNodes((nds) => [
      ...nds,
      {
        id: newId,
        type: 'videoNode',
        position: {
          x: Math.random() * 600 - 300,
          y: Math.random() * 400 - 200
        },
        data: {
          initialPrompt: '',
          registerWebview,
          unregisterWebview,
          onBranch: onBranchStable,
          onClose: onCloseStable
        },
        dragHandle: '.video-node-header'
      }
    ])
  }, [registerWebview, unregisterWebview, onBranchStable, onCloseStable, setNodes])

  const handleNodesDelete = useCallback(
    (deleted) => {
      for (const node of deleted) {
        unregisterWebview(node.id)
      }
    },
    [unregisterWebview]
  )

  return (
    <div className="app-container">
      <div className="toolbar">
        <button className="add-chat-btn" onClick={handleAddRootChatNode}>+ New Chat</button>
        <button className="add-chat-btn" onClick={handleAddRootVideoNode} title="Video Studio">🎬 New Video</button>
        <button
          className="add-chat-btn"
          onClick={() => setShowSettings(true)}
          title="Settings"
          style={{ padding: '8px 12px' }}
        >⚙</button>
        <span className="toolbar-hint">Drag header to move. Scroll to zoom.</span>
        <div className="theme-picker">
          {Object.entries(themes).map(([key, t]) => (
            <button
              key={key}
              className={`theme-swatch ${themeName === key ? 'active' : ''}`}
              style={{ background: swatchColors[key] }}
              onClick={() => setThemeName(key)}
              title={t.label}
            />
          ))}
        </div>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={handleNodesDelete}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        maxZoom={2}
        defaultEdgeOptions={{
          animated: true,
          style: { stroke: 'var(--accent)', strokeWidth: 2 }
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant="dots" gap={20} size={1} color="var(--dots-color)" />
        <Controls position="bottom-right" />
        <MiniMap
          nodeColor="var(--accent)"
          maskColor="var(--minimap-mask)"
          style={{ backgroundColor: 'var(--minimap-bg)' }}
          position="bottom-left"
        />
      </ReactFlow>

      {showSettings && <SettingsDrawer onClose={() => setShowSettings(false)} />}
    </div>
  )
}

export default App
