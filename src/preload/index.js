import { contextBridge, ipcRenderer } from 'electron'

const VIDEO_STREAM = 'video:stream'

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
    }
  },

  secrets: {
    status: () => ipcRenderer.invoke('video:doctor').then((r) => r.secrets),
    get: (name) => ipcRenderer.invoke('video:getKey', { name }),
    set: (name, value) => ipcRenderer.invoke('video:setKey', { name, value })
  }
})
