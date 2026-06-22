export interface PixelateParams {
  sample_method: string
  refine_intensity: number
  grid_w?: number | null
  grid_h?: number | null
}

export interface PixelateResult {
  ok: boolean
  error?: string
  grid_w?: number
  grid_h?: number
  src_w?: number
  src_h?: number
  image_base64?: string
  src_base64?: string
}

export interface ExportResult {
  ok: boolean
  error?: string
  output_path?: string
  out_w?: number
  out_h?: number
}

let cachedPort: number | null = null

async function getBase(): Promise<string> {
  if (cachedPort == null) cachedPort = await window.ppApi.getSidecarPort()
  return `http://127.0.0.1:${cachedPort}`
}

/** 轮询等待 sidecar 就绪。 */
export async function waitForHealth(
  timeoutMs = 30000
): Promise<{ ok: boolean; backend?: string }> {
  const start = Date.now()
  const base = await getBase()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) {
        const j = await r.json()
        return { ok: true, backend: j.backend }
      }
    } catch {
      /* sidecar 尚未起来，继续重试 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false }
}

export async function pixelate(
  inputPath: string,
  p: PixelateParams
): Promise<PixelateResult> {
  const base = await getBase()
  const r = await fetch(`${base}/api/pixelate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_path: inputPath, ...p })
  })
  return r.json()
}

export async function exportImage(
  inputPath: string,
  outputPath: string,
  scale: number,
  p: PixelateParams
): Promise<ExportResult> {
  const base = await getBase()
  const r = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_path: inputPath, output_path: outputPath, scale, ...p })
  })
  return r.json()
}

/* ----------------------------- 批量处理 ----------------------------- */
export interface BatchParams {
  sample_method: string
  refine_intensity: number
  grid_w?: number | null
  grid_h?: number | null
  scale: number
  suffix: string
}

export interface BatchItem {
  name: string
  ok: boolean
  grid_w?: number
  grid_h?: number
  out_path?: string
  out_w?: number
  out_h?: number
  error?: string
}

export interface BatchResult {
  ok: boolean
  error?: string
  total?: number
  done?: number
  failed?: number
  output_dir?: string
  items?: BatchItem[]
}

export async function batchProcess(
  inputPaths: string[],
  outputDir: string,
  p: BatchParams
): Promise<JobStart> {
  const base = await getBase()
  const r = await fetch(`${base}/api/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_paths: inputPaths, output_dir: outputDir, ...p })
  })
  return r.json()
}

/* --------------------------- 任务 / 日志 --------------------------- */
export interface JobStart {
  ok: boolean
  error?: string
  job_id?: string
}

export interface JobState<T> {
  ok: boolean
  id?: string
  kind?: string
  status?: 'running' | 'done' | 'error'
  percent?: number
  stage?: string
  message?: string
  result?: T
  error?: string
}

export interface LogEntry {
  seq: number
  ts: number
  level: string
  msg: string
}

export interface LogsResponse {
  seq: number
  logs: LogEntry[]
}

export async function getLogs(since = 0): Promise<LogsResponse> {
  const base = await getBase()
  try {
    const r = await fetch(`${base}/api/logs?since=${since}`)
    return r.json()
  } catch {
    return { seq: since, logs: [] }
  }
}

export async function getJob<T>(jobId: string): Promise<JobState<T>> {
  const base = await getBase()
  const r = await fetch(`${base}/api/job/${jobId}`)
  return r.json()
}

/** 轮询任务直到 done/error。onProgress 在每次轮询时回调当前状态。 */
export async function pollJob<T>(
  jobId: string,
  onProgress?: (s: JobState<T>) => void,
  intervalMs = 600
): Promise<JobState<T>> {
  for (;;) {
    const s = await getJob<T>(jobId)
    if (!s.ok) return s
    onProgress?.(s)
    if (s.status === 'done' || s.status === 'error') return s
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/* ----------------------------- 抠图 ----------------------------- */
export interface MatteModel {
  id: string
  label: string
}

export interface MatteInfo {
  available: boolean
  models: MatteModel[]
  providers: string[]
  default_model: string
}

export interface MatteParams extends PixelateParams {
  model: string
  alpha_matting: boolean
  alpha_threshold: number
  decontaminate: boolean
}

export interface MatteResult extends PixelateResult {
  cutout_base64?: string
}

export async function getMatteInfo(): Promise<MatteInfo> {
  const base = await getBase()
  try {
    const r = await fetch(`${base}/api/matte/info`)
    return r.json()
  } catch {
    return { available: false, models: [], providers: [], default_model: 'u2net' }
  }
}

export async function matte(inputPath: string, p: MatteParams): Promise<JobStart> {
  const base = await getBase()
  const r = await fetch(`${base}/api/matte`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_path: inputPath, ...p })
  })
  return r.json()
}

export async function matteExport(
  inputPath: string,
  outputPath: string,
  scale: number,
  p: MatteParams
): Promise<JobStart> {
  const base = await getBase()
  const r = await fetch(`${base}/api/matte/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_path: inputPath, output_path: outputPath, scale, ...p })
  })
  return r.json()
}

/* --------------------------- 视频 / GIF --------------------------- */
export interface VideoProbeResult {
  ok: boolean
  error?: string
  frames?: number
  fps?: number
  width?: number
  height?: number
  preview_base64?: string
}

export interface VideoProcessParams {
  sample_method: string
  grid_w?: number | null
  grid_h?: number | null
  max_frames: number
  fps_out?: number | null
  scale: number
  fmt: string
  shared_palette: boolean
  palette_size: number
  matte: boolean
  matte_model: string
  alpha_threshold: number
}

export interface VideoProcessResult {
  ok: boolean
  error?: string
  output_path?: string
  frames?: number
  fps?: number
  grid_w?: number
  grid_h?: number
  out_w?: number
  out_h?: number
  fmt?: string
  preview_base64?: string
}

export async function videoProbe(
  inputPath: string,
  maxFrames = 240
): Promise<VideoProbeResult> {
  const base = await getBase()
  const r = await fetch(`${base}/api/video/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_path: inputPath, max_frames: maxFrames })
  })
  return r.json()
}

export async function videoProcess(
  inputPath: string,
  outputPath: string,
  p: VideoProcessParams
): Promise<JobStart> {
  const base = await getBase()
  const r = await fetch(`${base}/api/video/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_path: inputPath, output_path: outputPath, ...p })
  })
  return r.json()
}

/* --------------------------- 豆包 / 即梦 账号 --------------------------- */
export type Platform = 'jimeng' | 'doubao'

export interface Account {
  id: string
  platform: Platform
  name: string
  created_at: string
  last_check: string | null
  status: 'unknown' | 'logged_in' | 'logged_out'
  note: string
}

export interface LoginResult {
  ok: boolean
  logged_in?: boolean
  status?: string
  error?: string
}

export async function listAccounts(): Promise<{ ok: boolean; accounts: Account[] }> {
  const base = await getBase()
  try {
    const r = await fetch(`${base}/api/accounts`)
    return r.json()
  } catch {
    return { ok: false, accounts: [] }
  }
}

export async function addAccount(
  platform: Platform,
  name?: string
): Promise<{ ok: boolean; account?: Account; error?: string }> {
  const base = await getBase()
  const r = await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, name })
  })
  return r.json()
}

export async function deleteAccount(id: string): Promise<{ ok: boolean }> {
  const base = await getBase()
  const r = await fetch(`${base}/api/accounts/${id}`, { method: 'DELETE' })
  return r.json()
}

export async function loginAccount(id: string): Promise<LoginResult> {
  const base = await getBase()
  const r = await fetch(`${base}/api/accounts/${id}/login`, { method: 'POST' })
  return r.json()
}

export async function checkAccount(id: string): Promise<LoginResult> {
  const base = await getBase()
  const r = await fetch(`${base}/api/accounts/${id}/check`, { method: 'POST' })
  return r.json()
}

/* ----------------------------- AI 生图 ----------------------------- */
export interface GenerateParams {
  account_id: string
  prompt: string
  pixelate?: boolean
  sample_method?: string
  refine_intensity?: number
}

export interface GenImage {
  image_path: string
  source_url?: string
  image_base64?: string
}

export interface GenerateResult {
  ok: boolean
  error?: string
  images?: GenImage[]
  image_path?: string
  source_url?: string
  image_base64?: string
  pixel_grid_w?: number
  pixel_grid_h?: number
  pixel_base64?: string
  pixelate_error?: string
}

/** 启动 AI 生图（异步任务）。返回 job_id，用 pollJob 轮询拿进度与结果。 */
export async function generate(p: GenerateParams): Promise<JobStart> {
  const base = await getBase()
  const r = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p)
  })
  return r.json()
}

/* ----------------------------- 应用设置 ----------------------------- */
export interface AppSettings {
  output_dir: string
}

export async function getSettings(): Promise<{ ok: boolean; settings?: AppSettings }> {
  const base = await getBase()
  try {
    const r = await fetch(`${base}/api/settings`)
    return r.json()
  } catch {
    return { ok: false }
  }
}

export async function saveSettings(
  patch: Partial<AppSettings>
): Promise<{ ok: boolean; settings?: AppSettings }> {
  const base = await getBase()
  const r = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  return r.json()
}
