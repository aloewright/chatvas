import { contextBridge, ipcRenderer } from 'electron'

const VIDEO_STREAM = 'video:stream'
const REGISTRY_INVALIDATED = 'video:registry-invalidated'
const BOOTSTRAP_STREAM = 'bootstrap:stream'

contextBridge.exposeInMainWorld('electronAPI', {
  // --- ChatGPT branching (existing) ---
  onNewBranch: (callback) => {
    ipcRenderer.on('new-branch', (_event, data) => callback(data))
  },
  removeNewBranchListener: () => {
    ipcRenderer.removeAllListeners('new-branch')
  },

  // --- Video Studio ---
  video: {
    listPipelines: () => ipcRenderer.invoke('video:listPipelines'),
    listTools: () => ipcRenderer.invoke('video:listTools'),
    start: (args) => ipcRenderer.invoke('video:start', args),
    cancel: (jobId) => ipcRenderer.invoke('video:cancel', { jobId }),
    getJob: (jobId) => ipcRenderer.invoke('video:getJob', { jobId }),
    doctor: () => ipcRenderer.invoke('video:doctor'),
    openArtifact: (jobId, file) => ipcRenderer.invoke('video:openArtifact', { jobId, file }),
    getFileUrl: (path) => ipcRenderer.invoke('video:getFileUrl', { path }),
    listRenders: () => ipcRenderer.invoke('video:listRenders'),
    deleteRender: (jobId) => ipcRenderer.invoke('video:deleteRender', { jobId }),
    enforceQuota: (quotaGb) => ipcRenderer.invoke('video:enforceQuota', { quotaGb }),
    onStream: (jobId, cb) => {
      const handler = (_e, msg) => {
        if (!msg || msg.jobId !== jobId) return
        cb(msg)
      }
      ipcRenderer.on(VIDEO_STREAM, handler)
      return () => ipcRenderer.removeListener(VIDEO_STREAM, handler)
    },
    onRegistryInvalidated: (cb) => {
      const handler = () => cb()
      ipcRenderer.on(REGISTRY_INVALIDATED, handler)
      return () => ipcRenderer.removeListener(REGISTRY_INVALIDATED, handler)
    }
  },

  secrets: {
    status: () => ipcRenderer.invoke('video:doctor').then((r) => r.secrets),
    get: (name) => ipcRenderer.invoke('video:getKey', { name }),
    set: (name, value) => ipcRenderer.invoke('video:setKey', { name, value })
  },

  // --- AI Terminal (Claude Code / Codex) ---
  aiTerminal: {
    getProvider: () => ipcRenderer.invoke('ai-terminal:getProvider'),
    setProvider: (provider) => ipcRenderer.invoke('ai-terminal:setProvider', provider),
    start: (provider, prompt) => ipcRenderer.invoke('ai-terminal:start', provider, prompt),
    write: (text) => ipcRenderer.invoke('ai-terminal:write', text),
    stop: () => ipcRenderer.invoke('ai-terminal:stop'),
    enhancePrompt: (rawPrompt, platform) => ipcRenderer.invoke('ai-terminal:enhancePrompt', rawPrompt, platform),
    detectProviders: () => ipcRenderer.invoke('ai-terminal:detectProviders'),
    getCfWorkerUrl: () => ipcRenderer.invoke('ai-terminal:getCfWorkerUrl'),
    setCfWorkerUrl: (url) => ipcRenderer.invoke('ai-terminal:setCfWorkerUrl', url),
    getCfApiToken: () => ipcRenderer.invoke('ai-terminal:getCfApiToken'),
    setCfApiToken: (token) => ipcRenderer.invoke('ai-terminal:setCfApiToken', token),
    onOutput: (cb) => {
      const handler = (_e, msg) => cb(msg)
      ipcRenderer.on('ai-terminal:output', handler)
      return () => ipcRenderer.removeListener('ai-terminal:output', handler)
    }
  },

  // --- Doppler Secret Management ---
  doppler: {
    status: () => ipcRenderer.invoke('doppler:status'),
    configure: (config) => ipcRenderer.invoke('doppler:configure', config),
    test: () => ipcRenderer.invoke('doppler:test')
  },

  bootstrap: {
    status: () => ipcRenderer.invoke('bootstrap:status'),
    start: () => ipcRenderer.invoke('bootstrap:start'),
    retry: () => ipcRenderer.invoke('bootstrap:retry'),
    onStream: (cb) => {
      const handler = (_e, msg) => cb(msg)
      ipcRenderer.on(BOOTSTRAP_STREAM, handler)
      return () => ipcRenderer.removeListener(BOOTSTRAP_STREAM, handler)
    }
  },

  // --- Auth (cloudos-auth / better-auth loopback OAuth) ---
  auth: {
    signIn: (provider) => ipcRenderer.invoke('auth:signIn', provider),
    getSession: () => ipcRenderer.invoke('auth:getSession'),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    onChanged: (cb) => {
      const handler = (_e, msg) => cb(msg)
      ipcRenderer.on('auth:changed', handler)
      return () => ipcRenderer.removeListener('auth:changed', handler)
    }
  }
})
