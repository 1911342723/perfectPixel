import { useEffect, useRef, useState } from 'react'
import {
  getMatteInfo,
  pollJob,
  videoProbe,
  videoProcess,
  type MatteInfo,
  type VideoProbeResult,
  type VideoProcessResult
} from '../api'
import { SAMPLE_LABELS, baseName, type SampleMethod, type ViewProps } from './common'

type Fmt = 'gif' | 'mp4' | 'apng'

interface Progress {
  stage?: string
  percent?: number
  message?: string
}

const FMT_EXT: Record<Fmt, string> = { gif: 'gif', mp4: 'mp4', apng: 'png' }
const FMT_LABEL: Record<Fmt, string> = { gif: 'GIF', mp4: 'MP4', apng: 'APNG' }

export default function VideoView({ status, showToast }: ViewProps): React.JSX.Element {
  const [info, setInfo] = useState<MatteInfo | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [probe, setProbe] = useState<VideoProbeResult | null>(null)
  const [result, setResult] = useState<VideoProcessResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(6)
  const [progress, setProgress] = useState<Progress | null>(null)
  const jobToken = useRef(0)

  const [sample, setSample] = useState<SampleMethod>('center')
  const [manualGrid, setManualGrid] = useState(false)
  const [gridW, setGridW] = useState(32)
  const [gridH, setGridH] = useState(32)
  const [maxFrames, setMaxFrames] = useState(240)
  const [scale, setScale] = useState(8)
  const [fmt, setFmt] = useState<Fmt>('gif')
  const [fpsOut, setFpsOut] = useState(12)
  const [sharedPalette, setSharedPalette] = useState(true)
  const [paletteSize, setPaletteSize] = useState(64)
  const [matte, setMatte] = useState(false)
  const [matteModel, setMatteModel] = useState('u2net')
  const [alphaThreshold, setAlphaThreshold] = useState(128)

  useEffect(() => {
    getMatteInfo().then((i) => {
      setInfo(i)
      if (i.default_model) setMatteModel(i.default_model)
    })
  }, [])

  const onImport = async (): Promise<void> => {
    const p = await window.ppApi.openVideo()
    if (!p) return
    setPath(p)
    setResult(null)
    setError(null)
    setProbe(null)
    setBusy(true)
    const pr = await videoProbe(p, maxFrames)
    setBusy(false)
    if (!pr.ok) {
      setError(pr.error || '读取失败')
      return
    }
    setProbe(pr)
    if (pr.fps) setFpsOut(Math.max(1, Math.round(pr.fps)))
  }

  const onProcess = async (): Promise<void> => {
    if (!path) return
    if (matte && fmt === 'mp4') {
      showToast('MP4 不支持透明，将合成为不透明背景')
    }
    const name = `pixel_${baseName(path)?.replace(/\.[^.]+$/, '') || 'video'}.${FMT_EXT[fmt]}`
    const out = await window.ppApi.saveFile({
      defaultName: name,
      filters: [{ name: FMT_LABEL[fmt], extensions: [FMT_EXT[fmt]] }]
    })
    if (!out) return
    const token = ++jobToken.current
    setBusy(true)
    setError(null)
    setProgress({ message: '排队中…' })
    const start = await videoProcess(path, out, {
      sample_method: sample,
      grid_w: manualGrid ? gridW : null,
      grid_h: manualGrid ? gridH : null,
      max_frames: maxFrames,
      fps_out: fpsOut,
      scale,
      fmt,
      shared_palette: sharedPalette,
      palette_size: paletteSize,
      matte,
      matte_model: matteModel,
      alpha_threshold: alphaThreshold
    })
    if (!start.ok || !start.job_id) {
      setBusy(false)
      setProgress(null)
      setError(start.error || '任务启动失败')
      return
    }
    const final = await pollJob<VideoProcessResult>(start.job_id, (s) => {
      if (token === jobToken.current) setProgress({ stage: s.stage, percent: s.percent, message: s.message })
    })
    if (token !== jobToken.current) return
    setBusy(false)
    setProgress(null)
    if (final.status === 'error' || !final.result?.ok) {
      setError(final.error || final.result?.error || '处理失败')
      return
    }
    const r = final.result
    setResult(r)
    showToast(`已导出 ${FMT_LABEL[fmt]} · ${r.frames} 帧 ${r.out_w}×${r.out_h} → ${baseName(out)}`)
  }

  const matteAvailable = !!info?.available

  return (
    <>
      <main className="canvas">
        {!path ? (
          <div className="empty">
            <div className="empty-art" />
            <h2>视频 / GIF 完美像素化</h2>
            <p>锁定网格 + 共享调色板，输出不闪烁的像素动画 · 支持 MP4 / GIF / WEBM</p>
            <button className="btn primary lg" onClick={onImport} disabled={status !== 'ready'}>
              导入视频 / 动图
            </button>
          </div>
        ) : (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="stage-info">
                <span className="fname">{baseName(path)}</span>
                {probe?.ok && (
                  <span className="meta">
                    <b>{probe.frames}</b> 帧 · {probe.fps?.toFixed(1)} fps · {probe.width}×
                    {probe.height}
                  </span>
                )}
                {result?.ok && (
                  <span className="meta">
                    → 网格 <b>{result.grid_w}×{result.grid_h}</b> · {result.fmt?.toUpperCase()}
                  </span>
                )}
              </div>
            </div>

            <div className="viewport">
              {busy && (
                <div className="loading progress">
                  <div className="progress-msg">
                    {progress?.message || '处理中…（解码 → 逐帧像素化 → 编码）'}
                  </div>
                  {(progress?.stage === 'process' || progress?.stage === 'download') && (
                    <div className="progress-bar">
                      <span style={{ width: `${Math.max(2, progress?.percent || 0)}%` }} />
                    </div>
                  )}
                </div>
              )}
              {error && <div className="err">{error}</div>}
              {!busy && !error && result?.preview_base64 && (
                <img
                  className={`pixelated ${matte ? 'checker' : ''}`}
                  src={result.preview_base64}
                  style={{ width: (result.grid_w || 0) * zoom }}
                  alt="result-frame"
                />
              )}
              {!busy && !error && !result && probe?.preview_base64 && (
                <img className="smooth" src={probe.preview_base64} alt="first-frame" />
              )}
            </div>
          </div>
        )}
      </main>

      <aside className="inspector">
        <div className="section">
          <div className="section-title">来源</div>
          <button className="btn block" onClick={onImport} disabled={status !== 'ready'}>
            {path ? '更换视频 / 动图' : '导入视频 / 动图'}
          </button>
        </div>

        <div className="section">
          <div className="section-title">采样方式</div>
          <div className="segmented full">
            {(['center', 'median', 'majority'] as SampleMethod[]).map((m) => (
              <button key={m} className={sample === m ? 'on' : ''} onClick={() => setSample(m)}>
                {SAMPLE_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="section">
          <label className="check">
            <input
              type="checkbox"
              checked={manualGrid}
              onChange={(e) => setManualGrid(e.target.checked)}
            />
            <span>手动锁定网格（否则多帧投票自动检测）</span>
          </label>
          {manualGrid && (
            <div className="grid-inputs">
              <label>
                宽
                <input
                  type="number"
                  min={2}
                  max={256}
                  value={gridW}
                  onChange={(e) => setGridW(+e.target.value)}
                />
              </label>
              <label>
                高
                <input
                  type="number"
                  min={2}
                  max={256}
                  value={gridH}
                  onChange={(e) => setGridH(+e.target.value)}
                />
              </label>
            </div>
          )}
        </div>

        <div className="section">
          <label className="check">
            <input
              type="checkbox"
              checked={sharedPalette}
              onChange={(e) => setSharedPalette(e.target.checked)}
            />
            <span>共享调色板（消除颜色闪烁）</span>
          </label>
          {sharedPalette && (
            <div className="row">
              <span className="section-title">调色板色数</span>
              <span className="val">{paletteSize}</span>
            </div>
          )}
          {sharedPalette && (
            <input
              type="range"
              min={8}
              max={256}
              step={8}
              value={paletteSize}
              onChange={(e) => setPaletteSize(+e.target.value)}
            />
          )}
        </div>

        <div className="section">
          <label className="check">
            <input
              type="checkbox"
              checked={matte}
              disabled={!matteAvailable}
              onChange={(e) => setMatte(e.target.checked)}
            />
            <span>逐帧抠图{matteAvailable ? '' : '（需安装 rembg）'}</span>
          </label>
          {matte && matteAvailable && (
            <select
              className="select"
              value={matteModel}
              onChange={(e) => setMatteModel(e.target.value)}
            >
              {(info?.models || []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="section">
          <div className="grid-inputs">
            <label>
              最大帧数
              <input
                type="number"
                min={2}
                max={1200}
                value={maxFrames}
                onChange={(e) => setMaxFrames(+e.target.value)}
              />
            </label>
            <label>
              帧率
              <input
                type="number"
                min={1}
                max={60}
                value={fpsOut}
                onChange={(e) => setFpsOut(+e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="section">
          <div className="row">
            <span className="section-title">导出格式</span>
          </div>
          <div className="segmented full">
            {(['gif', 'mp4', 'apng'] as Fmt[]).map((f) => (
              <button key={f} className={fmt === f ? 'on' : ''} onClick={() => setFmt(f)}>
                {FMT_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        <div className="section">
          <div className="row">
            <span className="section-title">导出放大</span>
            <span className="val">{scale}×</span>
          </div>
          <input
            type="range"
            min={1}
            max={16}
            step={1}
            value={scale}
            onChange={(e) => setScale(+e.target.value)}
          />
        </div>

        <div className="section">
          <div className="row">
            <span className="section-title">预览缩放</span>
            <span className="val">{zoom}×</span>
          </div>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={zoom}
            onChange={(e) => setZoom(+e.target.value)}
          />
        </div>

        <div className="spacer" />

        <div className="section">
          <button
            className="btn primary block"
            onClick={onProcess}
            disabled={!probe?.ok || busy}
          >
            {busy ? '处理中…' : `处理并导出 ${FMT_LABEL[fmt]}`}
          </button>
        </div>
      </aside>
    </>
  )
}
