import { contextBridge, ipcRenderer } from 'electron'

export interface SaveFileOptions {
  defaultName?: string
  filters?: { name: string; extensions: string[] }[]
}

const api = {
  getSidecarPort: (): Promise<number> => ipcRenderer.invoke('sidecar:port'),
  openImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:openImage'),
  openImages: (): Promise<string[]> => ipcRenderer.invoke('dialog:openImages'),
  openDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDir'),
  openPath: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', p),
  setTitleBarTheme: (dark: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setTitleBarOverlay', dark),
  saveImage: (defaultName?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveImage', defaultName),
  openVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),
  saveFile: (opts?: SaveFileOptions): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', opts)
}

contextBridge.exposeInMainWorld('ppApi', api)
