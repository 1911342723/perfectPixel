export interface SaveFileOptions {
  defaultName?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface PPApi {
  getSidecarPort: () => Promise<number>
  openImage: () => Promise<string | null>
  openImages: () => Promise<string[]>
  openDir: () => Promise<string | null>
  openPath: (p: string) => Promise<boolean>
  setTitleBarTheme: (dark: boolean) => Promise<void>
  saveImage: (defaultName?: string) => Promise<string | null>
  openVideo: () => Promise<string | null>
  saveFile: (opts?: SaveFileOptions) => Promise<string | null>
}

declare global {
  interface Window {
    ppApi: PPApi
  }
}
