/**
 * Desktop shell.
 *
 * The simulator is a self-contained web app, so packaging for Windows/macOS/Linux
 * is just loading the built bundle from disk — no server, no network access
 * needed at runtime. In development it points at the Vite dev server instead.
 */
const { app, BrowserWindow, Menu } = require('electron')
const path = require('node:path')

const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL

// The renderer is a WebGL game: let it use the discrete GPU and skip the
// background throttling Chromium applies to ordinary pages.
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0b0f17',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Needed so Rapier's WASM can compile without a network-backed CSP fetch.
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  return win
}

Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
