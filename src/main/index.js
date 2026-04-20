import { app, BrowserWindow, shell, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { registerVideoIpc } from './video-ipc.js'

// Serve local rendered artifacts via a custom privileged scheme so the renderer can load them
// from the dev-server origin without disabling webSecurity. The renderer asks for a URL via
// `video:getFileUrl`; the main process returns `chatvas-media://<encoded-path>`.
protocol.registerSchemesAsPrivileged([
  { scheme: 'chatvas-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Chat Nodes Canvas',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Load renderer from vite dev server in dev, or from built files in prod
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Intercept ALL new-window requests from webviews.
// This is the core mechanism: when ChatGPT's "Branch in new chat" tries to
// open a new tab, we deny it and instead tell the renderer to create a new
// canvas node with that URL.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-branch', {
          url,
          sourceWebContentsId: contents.id
        })
      }
      return { action: 'deny' }
    })

    // Intercept external link navigation (non-chatgpt links) -> open in system browser
    contents.on('will-navigate', (event, url) => {
      const parsed = new URL(url)
      const allowedHosts = ['chatgpt.com', 'auth0.openai.com', 'auth.openai.com', 'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com']
      const isAllowed = allowedHosts.some(
        (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h)
      )
      if (!isAllowed) {
        event.preventDefault()
        shell.openExternal(url)
      }
    })
  }
})

app.whenReady().then(() => {
  // chatvas-media:// — serves local files returned by video:getFileUrl.
  // URL form: chatvas-media://host/<url-encoded-absolute-path>
  // Parsed as: decodeURIComponent(new URL(request.url).pathname)  (pathname has the leading "/")
  try {
    protocol.handle('chatvas-media', (request) => {
      const u = new URL(request.url)
      // `pathname` starts with "/"; strip and decode.
      const abs = decodeURIComponent(u.pathname.replace(/^\//, ''))
      return net.fetch(pathToFileURL(abs).href)
    })
  } catch (e) {
    console.warn('[main] failed to register chatvas-media protocol:', e?.message)
  }

  createWindow()
  registerVideoIpc({ getMainWindow: () => mainWindow })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
