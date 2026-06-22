import { useRef, useState } from 'react'
import { batchProcess, pollJob, type BatchResult } from '../api'
import { SAMPLE_LABELS, baseName, type SampleMethod, type ViewProps } from './common'

interface Progress {
  percent?: number
  message?: string
}

interface Row {
  name: string
  ok?: boolean
  grid_w?: number
  grid_h?: number
  error?: string
}

export default function BatchView({ status, showToast }: ViewProps): React.JSX.Element {
  const [paths, setPaths] = useState<string[]>([])
  const [outputDir, setOutputDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<BatchResult | null>(null)
  const jobToken = useRef(0)

  const [sample, setSample] = useState<SampleMethod>('center')
  const [refine, setRefine] = useState(0.3)
  const [manualGrid, setManualGrid] = useState(false)
  const [gridW, setGridW] = useState(32)
  const [gridH, setGridH] = useState(32)
  const [scale, setScale] = useState(8)
  const [suffix, setSuffix] = useState('_pixel')

  const onImport = async (): Promise<void> => {
    const ps = await window.ppApi.openImages()
    if (ps && ps.length) {
      setPaths(ps)
      setResult(null)
      setError(null)
    }
  }

  const onPickDir = async (): Promise<void> => {
    const d = await window.ppApi.openDir()
    if (d) setOutputDir(d)
  }

  const onRun = async (): Promise<void> => {
    if (!paths.length) {
      showToast('请先导入图片')
      return
    }
    if (!outputDir) {
      showToast('请先选择输出目录')
      return
    }
    const token = ++jobToken.current
    setBusy(true)
    setError(null)
    setResult(null)
    setProgress({ message: '排队中…', percent: 0 })
    const start = await batchProcess(paths, outputDir, {
      sample_method: sample,
      refine_intensity: refine,
      grid_w: manualGrid ? gridW : null,
      grid_h: manualGrid ? gridH : null,
      scale,
      suffix: suffix.trim() || '_pixel'
    })
    if (token !== jobToken.current) return
    if (!start.ok || !start.job_id) {
      setBusy(false)
      setProgress(null)
      setError(start.error || '任务启动失败')
      return
    }
    const final = await pollJob<BatchResult>(start.job_id, (s) => {
      if (token === jobToken.current) setProgress({ percent: s.percent, message: s.message })
    })
    if (token !== jobToken.current) return
    setBusy(false)
    setProgress(null)
    if (final.status === 'error' || !final.result?.ok) {
      setError(final.error || final.result?.error || '批量处理失败')
      return
    }
    setResult(final.result)
    showToast(`批量完成 · 成功 ${final.result.done}/${final.result.total} → ${baseName(outputDir)}`)
  }

  const hasFiles = paths.length > 0
  const rows: Row[] = result?.items
    ? result.items
    : paths.map((p) => ({ name: baseName(p) || p }))

  return (
    <>
      <main className="canvas">
        {!hasFiles ? (
          <div className="empty">
            <div className="empty-art" />
            <h2>批量完美像素化</h2>
            <p>一次导入多张图片 → 队列处理 → 批量导出到指定文件夹</p>
            <button className="btn primary lg" onClick={onImport} disabled={status !== 'ready'}>
              导入多张图片
            </button>
          </div>
        ) : (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="stage-info">
                <span className="meta">
                  <b>{paths.length}</b> 张待处理
                </span>
                {result && (
                  <span className="meta">
                    成功 <b>{result.done}</b> · 失败 <b>{result.failed}</b>
                  </span>
                )}
              </div>
            </div>

            {busy && (
              <div className="batch-progress">
                <div className="progress-msg">{progress?.message || '处理中…'}</div>
                <div className="progress-bar">
                  <span style={{ width: `${Math.max(2, progress?.percent || 0)}%` }} />
                </div>
              </div>
            )}
            {error && (
              <div className="batch-banner">
                <div className="err">{error}</div>
              </div>
            )}

            <div className="batch-list">
              {rows.map((r, i) => {
                const state = r.ok === undefined ? 'pending' : r.ok ? 'ok' : 'fail'
                return (
                  <div className="batch-item" key={`${r.name}-${i}`}>
                    <span className="batch-idx">{i + 1}</span>
                    <span className="batch-name" title={r.name}>
                      {r.name}
                    </span>
                    {state === 'pending' && <span className="batch-stat pending">待处理</span>}
                    {state === 'ok' && (
                      <span className="batch-stat ok">
                        {r.grid_w}×{r.grid_h}
                      </span>
                    )}
                    {state === 'fail' && (
                      <span className="batch-stat fail" title={r.error}>
                        失败
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </main>

      <aside className="inspector">
        <div className="section">
          <div className="section-title">来源</div>
          <button className="btn block" onClick={onImport} disabled={status !== 'ready'}>
            {hasFiles ? `重新选择（已选 ${paths.length}）` : '导入多张图片'}
          </button>
        </div>

        <div className="section">
          <div className="section-title">输出目录</div>
          <button className="btn block" onClick={onPickDir} disabled={status !== 'ready'}>
            {outputDir ? '更换输出目录' : '选择输出目录'}
          </button>
          {outputDir && (
            <span className="hint-line" title={outputDir}>
              {outputDir}
            </span>
          )}
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
            <span>统一网格（全批使用同一尺寸）</span>
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
          <div className="section-title">文件名后缀</div>
          <input
            className="text-input"
            type="text"
            value={suffix}
            placeholder="_pixel"
            onChange={(e) => setSuffix(e.target.value)}
          />
          <span className="hint-line">输出：原名{suffix.trim() || '_pixel'}.png</span>
        </div>

        <div className="spacer" />

        <div className="section">
          <button
            className="btn primary block"
            onClick={onRun}
            disabled={!hasFiles || !outputDir || busy || status !== 'ready'}
          >
            {busy ? '处理中…' : `开始批量（${paths.length}）`}
          </button>
        </div>
      </aside>
    </>
  )
}
