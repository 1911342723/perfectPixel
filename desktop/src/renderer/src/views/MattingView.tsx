import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getMatteInfo,
  matte,
  matteExport,
  pollJob,
  type ExportResult,
  type MatteInfo,
  type MatteResult
} from '../api'
import { SAMPLE_LABELS, baseName, type SampleMethod, type ViewProps } from './common'

type ViewMode = 'result' | 'cutout' | 'original'

interface Progress {
  stage?: string
  percent?: number
  message?: string
}

export default function MattingView({ status, showToast }: ViewProps): React.JSX.Element {
  const [info, setInfo] = useState<MatteInfo | null>(null)
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [result, setResult] = useState<MatteResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('result')
  const [zoom, setZoom] = useState(8)
  const [progress, setProgress] = useState<Progress | null>(null)
  const jobToken = useRef(0)

  const [model, setModel] = useState('u2net')
  const [alphaMatting, setAlphaMatting] = useState(false)
  const [decon, setDecon] = useState(true)
  const [threshold, setThreshold] = useState(128)
  const [sample, setSample] = useState<SampleMethod>('center')
  const [refine, setRefine] = useState(0.3)
  const [manualGrid, setManualGrid] = useState(false)
  const [gridW, setGridW] = useState(32)
  const [gridH, setGridH] = useState(32)

  useEffect(() => {
    getMatteInfo().then((i) => {
      setInfo(i)
      if (i.default_model) setModel(i.default_model)
    })
  }, [])

  const runMatte = useCallback(
    async (path: string) => {
      const token = ++jobToken.current
      setBusy(true)
      setError(null)
      setProgress({ message: '排队中…' })
      const start = await matte(path, {
        model,
        alpha_matting: alphaMatting,
        alpha_threshold: threshold,
        decontaminate: decon,
        sample_method: sample,
        refine_intensity: refine,
        grid_w: manualGrid ? gridW : null,
        grid_h: manualGrid ? gridH : null
      })
      if (token !== jobToken.current) return
      if (!start.ok || !start.job_id) {
        setBusy(false)
        setProgress(null)
        setError(start.error || '任务启动失败')
        return
      }
      const final = await pollJob<MatteResult>(start.job_id, (s) => {
        if (token === jobToken.current) {
          setProgress({ stage: s.stage, percent: s.percent, message: s.message })
        }
      })
      if (token !== jobToken.current) return
      setBusy(false)
      setProgress(null)
      if (final.status === 'error' || !final.result?.ok) {
        setError(final.error || final.result?.error || '抠图失败')
        return
      }
      setResult(final.result)
      setView('result')
    },
    [model, alphaMatting, decon, threshold, sample, refine, manualGrid, gridW, gridH]
  )

  useEffect(() => {
    if (!imagePath || status !== 'ready' || !info?.available) return
    const t = setTimeout(() => runMatte(imagePath), 300)
    return () => clearTimeout(t)
  }, [imagePath, model, alphaMatting, decon, threshold, sample, refine, manualGrid, gridW, gridH, status, info, runMatte])

  const onImport = async (): Promise<void> => {
    const p = await window.ppApi.openImage()
    if (p) {
      setImagePath(p)
      setResult(null)
      setError(null)
    }
  }

  const onExport = async (): Promise<void> => {
    if (!imagePath || !result?.ok) return
    const name = `cutout_${result.grid_w}x${result.grid_h}.png`
    const out = await window.ppApi.saveFile({
      defaultName: name,
      filters: [{ name: '透明 PNG', extensions: ['png'] }]
    })
    if (!out) return
    const token = ++jobToken.current
    setBusy(true)
    setProgress({ message: '导出中…' })
    const start = await matteExport(imagePath, out, zoom, {
      model,
      alpha_matting: alphaMatting,
      alpha_threshold: threshold,
      decontaminate: decon,
      sample_method: sample,
      refine_intensity: refine,
      grid_w: manualGrid ? gridW : null,
      grid_h: manualGrid ? gridH : null
    })
    if (!start.ok || !start.job_id) {
      setBusy(false)
      setProgress(null)
      setError(start.error || '导出启动失败')
      return
    }
    const final = await pollJob<ExportResult>(start.job_id, (s) => {
      if (token === jobToken.current) setProgress({ stage: s.stage, percent: s.percent, message: s.message })
    })
    setBusy(false)
    setProgress(null)
    if (final.status === 'error' || !final.result?.ok) {
      setError(final.error || final.result?.error || '导出失败')
      return
    }
    showToast(`已导出透明 PNG ${final.result.out_w}×${final.result.out_h} → ${baseName(out)}`)
  }

  // rembg 未安装
  if (info && !info.available) {
    return (
      <>
        <main className="canvas">
          <div className="empty">
            <div className="empty-art" />
            <h2>抠图依赖未就绪</h2>
            <p>
              一键抠图需要 <code>rembg</code> + ONNX Runtime。请在 sidecar 的 Python
              环境安装后重启应用：
            </p>
            <pre className="code-hint">pip install rembg</pre>
            <p className="dim">首次抠图会自动下载所选模型（u2net 约 176MB）。</p>
          </div>
        </main>
        <aside className="inspector">
          <div className="section">
            <div className="section-title">状态</div>
            <p className="dim">未检测到 rembg。安装并重启后即可使用一键抠图。</p>
          </div>
        </aside>
      </>
    )
  }

  const gpu = info?.providers?.some((p) => /CUDA|Dml|Tensorrt/i.test(p))

  return (
    <>
      <main className="canvas">
        {!imagePath ? (
          <div className="empty">
            <div className="empty-art" />
            <h2>一键抠图 · 像素化透明素材</h2>
            <p>自动去背景 → 硬化边缘 → 完美像素化，导出透明 PNG</p>
            <button className="btn primary lg" onClick={onImport} disabled={status !== 'ready'}>
              导入图片
            </button>
          </div>
        ) : (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="segmented">
                <button className={view === 'result' ? 'on' : ''} onClick={() => setView('result')}>
                  像素结果
                </button>
                <button className={view === 'cutout' ? 'on' : ''} onClick={() => setView('cutout')}>
                  抠图
                </button>
                <button
                  className={view === 'original' ? 'on' : ''}
                  onClick={() => setView('original')}
                >
                  原图
                </button>
              </div>
              <div className="stage-info">
                <span className="fname">{baseName(imagePath)}</span>
                {result?.ok && (
                  <span className="meta">
                    网格 <b>{result.grid_w}×{result.grid_h}</b> · 源 {result.src_w}×{result.src_h}
                  </span>
                )}
              </div>
            </div>

            <div className="viewport">
              {busy && (
                <div className="loading progress">
                  <div className="progress-msg">{progress?.message || '处理中…'}</div>
                  {progress?.stage === 'download' && (
                    <div className="progress-bar">
                      <span style={{ width: `${Math.max(2, progress?.percent || 0)}%` }} />
                    </div>
                  )}
                </div>
              )}
              {error && <div className="err">{error}</div>}
              {!error && view === 'result' && result?.image_base64 && (
                <img
                  className="pixelated checker"
                  src={result.image_base64}
                  style={{ width: (result.grid_w || 0) * zoom }}
                  alt="result"
                />
              )}
              {!error && view === 'cutout' && result?.cutout_base64 && (
                <img className="smooth checker" src={result.cutout_base64} alt="cutout" />
              )}
              {!error && view === 'original' && result?.src_base64 && (
                <img className="smooth" src={result.src_base64} alt="original" />
              )}
            </div>
          </div>
        )}
      </main>

      <aside className="inspector">
        <div className="section">
          <div className="section-title">来源</div>
          <button className="btn block" onClick={onImport} disabled={status !== 'ready'}>
            {imagePath ? '更换图片' : '导入图片'}
          </button>
        </div>

        <div className="section">
          <div className="section-title">抠图模型</div>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            {(info?.models || [{ id: 'u2net', label: 'U2Net · 通用' }]).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="hint-line">
            后端：{gpu ? 'GPU 可用' : 'CPU'}（{(info?.providers || []).length} provider）
          </span>
        </div>

        <div className="section">
          <label className="check">
            <input
              type="checkbox"
              checked={alphaMatting}
              onChange={(e) => setAlphaMatting(e.target.checked)}
            />
            <span>边缘精修（更慢，发丝更好）</span>
          </label>
        </div>

        <div className="section">
          <label className="check">
            <input
              type="checkbox"
              checked={decon}
              onChange={(e) => setDecon(e.target.checked)}
            />
            <span>去色边（消除边缘背景色溢出）</span>
          </label>
        </div>

        <div className="section">
          <div className="row">
            <span className="section-title">Alpha 硬化阈值</span>
            <span className="val">{threshold}</span>
          </div>
          <input
            type="range"
            min={1}
            max={254}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(+e.target.value)}
          />
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
          <div className="row">
            <span className="section-title">细化强度</span>
            <span className="val">{refine.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={refine}
            onChange={(e) => setRefine(parseFloat(e.target.value))}
          />
        </div>

        <div className="section">
          <label className="check">
            <input
              type="checkbox"
              checked={manualGrid}
              onChange={(e) => setManualGrid(e.target.checked)}
            />
            <span>手动指定网格</span>
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
          <button className="btn primary block" onClick={onExport} disabled={!result?.ok || busy}>
            导出透明 PNG（{zoom}×）
          </button>
        </div>
      </aside>
    </>
  )
}
