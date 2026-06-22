import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, dirname } from 'path'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync } from 'fs'

let mainWindow: BrowserWindow | null = null
let sidecar: ChildProcess | null = null
let sidecarPort = 0

/** 找一个空闲端口给 sidecar 用，避免端口冲突。 */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolvePort(p))
    })
  })
}

/** 定位 Python sidecar 脚本：开发态在 desktop/python，打包态在 resources/python。 */
function resolveSidecarScript(): string {
  const devPath = join(__dirname, '../../python/app.py')
  if (existsSync(devPath)) return devPath
  return join(process.resourcesPath, 'python', 'app.py')
}

async function startSidecar(): Promise<void> {
  sidecarPort = await getFreePort()
  const script = resolveSidecarScript()
  const py = process.platform === 'win32' ? 'python' : 'python3'
  const args = [script, '--port', String(sidecarPort)]
  // 开发态（未打包）开启 Python 热重载：改 sidecar 的 .py 自动重启，无需重跑 npm run dev
  const reload = !app.isPackaged
  if (reload) args.push('--reload')
  sidecar = spawn(py, args, {
    cwd: dirname(script),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  sidecar.stdout?.on('data', (d) => console.log('[sidecar]', String(d).trim()))
  sidecar.stderr?.on('data', (d) => console.log('[sidecar]', String(d).trim()))
  sidecar.on('exit', (code) => console.log('[sidecar] exited with', code))
  console.log(
    `[main] sidecar starting on 127.0.0.1:${sidecarPort} (${script})${reload ? ' [reload]' : ''}`
  )
}

function stopSidecar(): void {
  if (!sidecar || sidecar.killed) {
    sidecar = null
    return
  }
  const pid = sidecar.pid
  try {
    // 热重载下 uvicorn 会派生子 worker；只 kill 父进程会留下孤儿占用端口，
    // 故 Windows 用 taskkill /T 按进程树整体结束。
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
    } else {
      sidecar.kill()
    }
  } catch {
    sidecar.kill()
  }
  sidecar = null
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f8fa',
      symbolColor: '#1b1e23',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('sidecar:port', () => sidecarPort)

ipcMain.handle('dialog:openImage', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
})

ipcMain.handle('dialog:openImages', async () => {
  if (!mainWindow) return []
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('dialog:openDir', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
})

ipcMain.handle('shell:openPath', async (_e, p: string) => {
  if (!p) return false
  const err = await shell.openPath(p)
  return !err
})

ipcMain.handle('window:setTitleBarOverlay', (_e, dark: boolean) => {
  if (!mainWindow) return
  try {
    mainWindow.setTitleBarOverlay({
      color: dark ? '#101317' : '#f7f8fa',
      symbolColor: dark ? '#e7eaee' : '#1b1e23',
      height: 40
    })
  } catch {
    /* 平台不支持 titleBarOverlay 时忽略 */
  }
})

ipcMain.handle('dialog:saveImage', async (_e, defaultName?: string) => {
  if (!mainWindow) return null
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'pixel.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  })
  return r.canceled || !r.filePath ? null : r.filePath
})

ipcMain.handle('dialog:openVideo', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '视频 / 动图', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'gif', 'apng', 'webp'] }
    ]
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
})

ipcMain.handle(
  'dialog:saveFile',
  async (_e, opts?: { defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => {
    if (!mainWindow) return null
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: opts?.defaultName || 'output',
      filters: opts?.filters || [{ name: '所有文件', extensions: ['*'] }]
    })
    return r.canceled || !r.filePath ? null : r.filePath
  }
)

app.whenReady().then(async () => {
  try {
    await startSidecar()
  } catch (e) {
    console.error('[main] 启动 sidecar 失败:', e)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopSidecar()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopSidecar)
app.on('will-quit', stopSidecar)
