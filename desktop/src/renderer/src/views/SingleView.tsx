import { useCallback, useEffect, useState } from 'react'
import { exportImage, pixelate, type PixelateResult } from '../api'
import { SAMPLE_LABELS, baseName, type SampleMethod, type ViewProps } from './common'

type ViewMode = 'result' | 'original'

export default function SingleView({ status, showToast }: ViewProps): React.JSX.Element {
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [result, setResult] = useState<PixelateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('result')
  const [zoom, setZoom] = useState(8)

  const [sample, setSample] = useState<SampleMethod>('center')
  const [refine, setRefine] = useState(0.3)
  const [manualGrid, setManualGrid] = useState(false)
  const [gridW, setGridW] = useState(32)
  const [gridH, setGridH] = useState(32)

  const runPixelate = useCallback(
    async (path: string) => {
      setBusy(true)
      setError(null)
      const res = await pixelate(path, {
        sample_method: sample,
        refine_intensity: refine,
        grid_w: manualGrid ? gridW : null,
        grid_h: manualGrid ? gridH : null
      })
      setBusy(false)
      if (!res.ok) {
        setError(res.error || '处理失败')
        return
      }
      setResult(res)
      setView('result')
    },
    [sample, refine, manualGrid, gridW, gridH]
  )

  useEffect(() => {
    if (!imagePath || status !== 'ready') return
    const t = setTimeout(() => runPixelate(imagePath), 250)
    return () => clearTimeout(t)
  }, [imagePath, sample, refine, manualGrid, gridW, gridH, status, runPixelate])

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
    const name = `pixel_${result.grid_w}x${result.grid_h}.png`
    const out = await window.ppApi.saveImage(name)
    if (!out) return
    setBusy(true)
    const r = await exportImage(imagePath, out, zoom, {
      sample_method: sample,
      refine_intensity: refine,
      grid_w: manualGrid ? gridW : null,
      grid_h: manualGrid ? gridH : null
    })
    setBusy(false)
    if (r.ok) showToast(`已导出 ${r.out_w}×${r.out_h} → ${baseName(out)}`)
    else setError(r.error || '导出失败')
  }

  return (
    <>
      <main className="canvas">
        {!imagePath ? (
          <div className="empty">
            <div className="empty-art" />
            <h2>导入一张像素风图片</h2>
            <p>自动检测网格并完美像素化 · 支持 PNG / JPG / WEBP</p>
            <button className="btn primary lg" onClick={onImport} disabled={status !== 'ready'}>
              导入图片
            </button>
          </div>
        ) : (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="segmented">
                <button className={view === 'result' ? 'on' : ''} onClick={() => setView('result')}>
                  结果
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
              {busy && <div className="loading">处理中…</div>}
              {error && <div className="err">{error}</div>}
              {!error && view === 'result' && result?.image_base64 && (
                <img
                  className="pixelated"
                  src={result.image_base64}
                  style={{ width: (result.grid_w || 0) * zoom }}
                  alt="result"
                />
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
            导出 PNG（{zoom}×）
          </button>
        </div>
      </aside>
    </>
  )
}
