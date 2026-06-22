import { useCallback, useEffect, useRef, useState } from 'react'
import {
  batchProcess,
  exportImage,
  generate,
  getMatteInfo,
  listAccounts,
  matte,
  matteExport,
  pixelate,
  pollJob,
  type Account,
  type BatchResult,
  type ExportResult,
  type GenImage,
  type GenerateResult,
  type MatteInfo,
  type MatteResult,
  type Platform
} from '../api'
import { SAMPLE_LABELS, baseName, type SampleMethod, type ViewProps } from './common'
import PixelCanvas from './PixelCanvas'
import TagPromptInput, { splitTags } from './TagPromptInput'
import {
  PROMPT_CATEGORIES,
  formatPromptTag,
  strToTag,
  tagValue,
  type PresetTag,
  type PromptTag
} from './promptPresets'

const PLATFORM_LABEL: Record<Platform, string> = { jimeng: '即梦', doubao: '豆包' }

// 词库特殊分类标识 + 本地持久化（收藏 / 自定义标签）
const FAV_CAT = '__fav__'
const CUSTOM_CAT = '__custom__'
const LS_FAVORITES = 'pp.prompt.favorites'
const LS_CUSTOM = 'pp.prompt.custom'

const loadList = (key: string): string[] => {
  try {
    const raw = localStorage.getItem(key)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const saveList = (key: string, list: string[]): void => {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* 忽略持久化失败 */
  }
}
const uniqByValue = (arr: PresetTag[]): PresetTag[] => {
  const seen = new Set<string>()
  return arr.filter((t) => {
    const v = tagValue(t)
    if (seen.has(v)) return false
    seen.add(v)
    return true
  })
}

type Mode = 'gallery' | 'edit'
type EditView = 'result' | 'cutout' | 'original'

/** 编辑结果（完美像素化 / 抠图）统一形状，兼容 PixelateResult 与 MatteResult。 */
interface EditResult {
  image_base64?: string
  cutout_base64?: string
  src_base64?: string
  grid_w?: number
  grid_h?: number
  src_w?: number
  src_h?: number
}

export default function GenerateView({ status, showToast }: ViewProps): React.JSX.Element {
  // —— 账号 / 生成 ——
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [tags, setTags] = useState<PromptTag[]>([])
  const [draft, setDraft] = useState('')
  const [showLibrary, setShowLibrary] = useState(false)
  const [libCat, setLibCat] = useState<string>(PROMPT_CATEGORIES[0].name)
  const [libQuery, setLibQuery] = useState('')
  const [favorites, setFavorites] = useState<string[]>(() => loadList(LS_FAVORITES))
  const [customTags, setCustomTags] = useState<string[]>(() => loadList(LS_CUSTOM))
  const [newTag, setNewTag] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genProgress, setGenProgress] = useState('')
  const [genError, setGenError] = useState<string | null>(null)
  const [images, setImages] = useState<GenImage[]>([])
  // 生成态：多选候选 → 批量导出
  const [picked, setPicked] = useState<number[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchMsg, setBatchMsg] = useState('')

  // —— 编辑（工作室） ——
  const [mode, setMode] = useState<Mode>('gallery')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [result, setResult] = useState<EditResult | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editMsg, setEditMsg] = useState('')
  const [editPct, setEditPct] = useState<number | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editView, setEditView] = useState<EditView>('result')
  const [zoom, setZoom] = useState(8)
  const jobToken = useRef(0)

  // —— 编辑参数（完美像素化 + 可选抠图） ——
  const [doMatte, setDoMatte] = useState(false)
  const [sample, setSample] = useState<SampleMethod>('center')
  const [refine, setRefine] = useState(0.3)
  const [manualGrid, setManualGrid] = useState(false)
  const [gridW, setGridW] = useState(32)
  const [gridH, setGridH] = useState(32)
  const [info, setInfo] = useState<MatteInfo | null>(null)
  const [model, setModel] = useState('u2net')
  const [alphaMatting, setAlphaMatting] = useState(false)
  const [decon, setDecon] = useState(true)
  const [threshold, setThreshold] = useState(128)

  useEffect(() => {
    if (status !== 'ready') return
    listAccounts().then((r) => {
      if (r.ok) {
        setAccounts(r.accounts)
        setAccountId((cur) => cur || (r.accounts[0]?.id ?? ''))
      }
    })
  }, [status])

  useEffect(() => {
    getMatteInfo().then((i) => {
      setInfo(i)
      if (i.default_model) setModel(i.default_model)
    })
  }, [])

  // 编辑态重算：去背景(可选) → 完美像素化。防抖 + 任务令牌避免回填竞态。
  const runEdit = useCallback(
    async (idx: number) => {
      const im = images[idx]
      if (!im) return
      const token = ++jobToken.current
      const matteOn = doMatte && !!info?.available
      setEditBusy(true)
      setEditError(null)
      setEditPct(null)
      setEditMsg(matteOn ? '抠图 + 完美像素化…' : '完美像素化…')
      const grid = { grid_w: manualGrid ? gridW : null, grid_h: manualGrid ? gridH : null }
      try {
        if (matteOn) {
          const startJob = await matte(im.image_path, {
            model,
            alpha_matting: alphaMatting,
            alpha_threshold: threshold,
            decontaminate: decon,
            sample_method: sample,
            refine_intensity: refine,
            ...grid
          })
          if (token !== jobToken.current) return
          if (!startJob.ok || !startJob.job_id) {
            setEditBusy(false)
            setEditError(startJob.error || '抠图任务启动失败')
            return
          }
          const final = await pollJob<MatteResult>(startJob.job_id, (s) => {
            if (token === jobToken.current) {
              setEditMsg(s.message || '处理中…')
              setEditPct(s.stage === 'download' ? s.percent ?? null : null)
            }
          })
          if (token !== jobToken.current) return
          setEditBusy(false)
          if (final.status === 'error' || !final.result?.ok) {
            setEditError(final.error || final.result?.error || '抠图失败')
            return
          }
          setResult(final.result)
          setEditView('result')
        } else {
          const r = await pixelate(im.image_path, {
            sample_method: sample,
            refine_intensity: refine,
            ...grid
          })
          if (token !== jobToken.current) return
          setEditBusy(false)
          if (!r.ok) {
            setEditError(r.error || '完美像素化失败')
            return
          }
          setResult(r)
          setEditView('result')
        }
      } catch (e) {
        if (token === jobToken.current) {
          setEditBusy(false)
          setEditError(String(e))
        }
      }
    },
    [images, doMatte, info, model, alphaMatting, threshold, decon, sample, refine, manualGrid, gridW, gridH]
  )

  // 进入编辑态 / 改参数 → 防抖重算当前选中图
  useEffect(() => {
    if (mode !== 'edit' || status !== 'ready') return
    const t = setTimeout(() => runEdit(selectedIdx), 300)
    return () => clearTimeout(t)
  }, [mode, selectedIdx, status, runEdit])

  // 收集全部标签：已固化的 tags + 输入框里尚未回车的残留文本
  const collectTags = (): PromptTag[] => {
    const extra = splitTags(draft)
    if (!extra.length) return tags
    const merged = [...tags]
    for (const t of extra) if (!merged.some((x) => x.text === t)) merged.push({ text: t, weight: 1 })
    return merged
  }

  const toggleTag = (value: string): void => {
    setTags((cur) =>
      cur.some((t) => t.text === value)
        ? cur.filter((t) => t.text !== value)
        : [...cur, { text: value, weight: 1 }]
    )
  }

  const clearPrompt = (): void => {
    setTags([])
    setDraft('')
  }

  const toggleFavorite = (value: string): void => {
    setFavorites((cur) => {
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
      saveList(LS_FAVORITES, next)
      return next
    })
  }

  const addCustomTag = (): void => {
    const parts = splitTags(newTag)
    if (!parts.length) return
    setCustomTags((cur) => {
      const next = [...cur]
      for (const p of parts) if (!next.includes(p)) next.push(p)
      saveList(LS_CUSTOM, next)
      return next
    })
    setNewTag('')
  }

  const removeCustomTag = (value: string): void => {
    setCustomTags((cur) => {
      const next = cur.filter((v) => v !== value)
      saveList(LS_CUSTOM, next)
      return next
    })
  }

  const onGenerate = async (): Promise<void> => {
    if (!accountId) {
      showToast('请先在「账号」页添加并登录账号')
      return
    }
    const allTags = collectTags()
    if (!allTags.length) {
      showToast('请输入提示词或从词库选择标签')
      return
    }
    if (allTags.length !== tags.length) setTags(allTags)
    setDraft('')
    setShowLibrary(false)
    setGenerating(true)
    setGenError(null)
    setImages([])
    setPicked([])
    setResult(null)
    setMode('gallery')
    setGenProgress('启动任务…')
    const start = await generate({
      account_id: accountId,
      prompt: allTags.map(formatPromptTag).join(', '),
      pixelate: false
    })
    if (!start.ok || !start.job_id) {
      setGenerating(false)
      setGenProgress('')
      setGenError(start.error || '任务启动失败')
      return
    }
    const final = await pollJob<GenerateResult>(start.job_id, (s) =>
      setGenProgress(s.message || '生成中…')
    )
    setGenerating(false)
    setGenProgress('')
    if (final.status === 'error' || !final.result?.ok) {
      setGenError(final.error || final.result?.error || '生成失败')
      return
    }
    const res = final.result
    const imgs: GenImage[] =
      res.images && res.images.length
        ? res.images
        : res.image_path
          ? [{ image_path: res.image_path, source_url: res.source_url, image_base64: res.image_base64 }]
          : []
    setImages(imgs)
    setSelectedIdx(0)
    setMode('gallery')
    showToast(`已生成 ${imgs.length} 张候选，点选一张进入编辑`)
  }

  const onSelect = (idx: number): void => {
    setSelectedIdx(idx)
    setResult(null)
    setEditError(null)
    setEditBusy(true)
    setEditMsg(doMatte ? '抠图 + 完美像素化…' : '完美像素化…')
    setShowLibrary(false)
    setMode('edit')
  }

  const backToGallery = (): void => {
    jobToken.current++ // 取消编辑态进行中的任务回填
    setMode('gallery')
    setEditBusy(false)
  }

  const togglePick = (idx: number): void => {
    setPicked((cur) => (cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx]))
  }

  const toggleSelectAll = (): void => {
    setPicked((cur) => (cur.length === images.length ? [] : images.map((_, i) => i)))
  }

  const onBatchExport = async (): Promise<void> => {
    const paths = picked
      .map((i) => images[i]?.image_path)
      .filter((p): p is string => !!p)
    if (!paths.length) return
    const dir = await window.ppApi.openDir()
    if (!dir) return
    setBatchBusy(true)
    setBatchMsg('排队中…')
    const start = await batchProcess(paths, dir, {
      sample_method: sample,
      refine_intensity: refine,
      grid_w: manualGrid ? gridW : null,
      grid_h: manualGrid ? gridH : null,
      scale: zoom,
      suffix: '_pixel'
    })
    if (!start.ok || !start.job_id) {
      setBatchBusy(false)
      setBatchMsg('')
      showToast(start.error || '批量导出启动失败')
      return
    }
    const final = await pollJob<BatchResult>(start.job_id, (s) =>
      setBatchMsg(s.message || '处理中…')
    )
    setBatchBusy(false)
    setBatchMsg('')
    if (final.status === 'error' || !final.result?.ok) {
      showToast(final.error || final.result?.error || '批量导出失败')
      return
    }
    const res = final.result
    showToast(`批量导出完成 ${res.done}/${res.total} → ${baseName(dir)}`)
  }

  const onExport = async (): Promise<void> => {
    const im = images[selectedIdx]
    if (!im || !result) return
    const matteOn = doMatte && !!info?.available
    const grid = { grid_w: manualGrid ? gridW : null, grid_h: manualGrid ? gridH : null }
    if (matteOn) {
      const out = await window.ppApi.saveFile({
        defaultName: `pixel_${result.grid_w}x${result.grid_h}.png`,
        filters: [{ name: '透明 PNG', extensions: ['png'] }]
      })
      if (!out) return
      const token = ++jobToken.current
      setEditBusy(true)
      setEditMsg('导出中…')
      const startJob = await matteExport(im.image_path, out, zoom, {
        model,
        alpha_matting: alphaMatting,
        alpha_threshold: threshold,
        decontaminate: decon,
        sample_method: sample,
        refine_intensity: refine,
        ...grid
      })
      if (!startJob.ok || !startJob.job_id) {
        setEditBusy(false)
        setEditError(startJob.error || '导出启动失败')
        return
      }
      const final = await pollJob<ExportResult>(startJob.job_id, (s) => {
        if (token === jobToken.current) setEditMsg(s.message || '导出中…')
      })
      setEditBusy(false)
      if (final.status === 'error' || !final.result?.ok) {
        setEditError(final.error || final.result?.error || '导出失败')
        return
      }
      showToast(`已导出透明 PNG ${final.result.out_w}×${final.result.out_h} → ${baseName(out)}`)
    } else {
      const out = await window.ppApi.saveImage(`pixel_${result.grid_w}x${result.grid_h}.png`)
      if (!out) return
      setEditBusy(true)
      const r = await exportImage(im.image_path, out, zoom, {
        sample_method: sample,
        refine_intensity: refine,
        ...grid
      })
      setEditBusy(false)
      if (r.ok) showToast(`已导出 ${r.out_w}×${r.out_h} → ${baseName(out)}`)
      else setEditError(r.error || '导出失败')
    }
  }

  const hasAccounts = accounts.length > 0
  const matteReady = !!info?.available
  const gpu = info?.providers?.some((p) => /CUDA|Dml|Tensorrt/i.test(p))
  const hasGallery = generating || images.length > 0 || !!genError

  // 词库：有搜索词则跨分类匹配（含自定义），否则展示当前分类（含收藏 / 我的标签）
  const libQ = libQuery.trim().toLowerCase()
  const libResults: PresetTag[] = libQ
    ? uniqByValue([...PROMPT_CATEGORIES.flatMap((c) => c.tags), ...customTags.map(strToTag)]).filter(
        (t) => tagValue(t).toLowerCase().includes(libQ) || t.label.toLowerCase().includes(libQ)
      )
    : libCat === FAV_CAT
      ? favorites.map(strToTag)
      : libCat === CUSTOM_CAT
        ? customTags.map(strToTag)
        : PROMPT_CATEGORIES.find((c) => c.name === libCat)?.tags ?? []

  return (
    <>
      <main className="canvas">
        {mode === 'edit' ? (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="stage-tabs">
                <button className="btn sm" onClick={backToGallery}>
                  ← 候选
                </button>
                <div className="segmented">
                  <button
                    className={editView === 'result' ? 'on' : ''}
                    onClick={() => setEditView('result')}
                    disabled={!result?.image_base64}
                  >
                    像素结果
                  </button>
                  {doMatte && (
                    <button
                      className={editView === 'cutout' ? 'on' : ''}
                      onClick={() => setEditView('cutout')}
                      disabled={!result?.cutout_base64}
                    >
                      抠图
                    </button>
                  )}
                  <button
                    className={editView === 'original' ? 'on' : ''}
                    onClick={() => setEditView('original')}
                    disabled={!result?.src_base64}
                  >
                    原图
                  </button>
                </div>
              </div>
              <div className="stage-info">
                {result?.grid_w ? (
                  <span className="meta">
                    网格 <b>{result.grid_w}×{result.grid_h}</b>
                  </span>
                ) : null}
                {images.length > 1 ? (
                  <span className="meta">
                    第 {selectedIdx + 1}/{images.length} 张
                  </span>
                ) : null}
              </div>
            </div>
            <div className="viewport">
              {editBusy && (
                <div className="loading progress">
                  <div className="progress-msg">{editMsg || '处理中…'}</div>
                  {editPct != null && (
                    <div className="progress-bar">
                      <span style={{ width: `${Math.max(2, editPct)}%` }} />
                    </div>
                  )}
                </div>
              )}
              {!editBusy && editError && <div className="err">{editError}</div>}
              {!editBusy && !editError && editView === 'result' && result?.image_base64 && (
                <PixelCanvas
                  src={result.image_base64}
                  baseW={result.grid_w || 0}
                  baseH={result.grid_h || 0}
                  pixelated
                />
              )}
              {!editBusy && !editError && editView === 'cutout' && result?.cutout_base64 && (
                <PixelCanvas
                  src={result.cutout_base64}
                  baseW={result.src_w || 0}
                  baseH={result.src_h || 0}
                  pixelated={false}
                />
              )}
              {!editBusy && !editError && editView === 'original' && result?.src_base64 && (
                <PixelCanvas
                  src={result.src_base64}
                  baseW={result.src_w || 0}
                  baseH={result.src_h || 0}
                  pixelated={false}
                />
              )}
            </div>
            {images.length > 1 && (
              <div className="gen-strip">
                {images.map((im, i) => (
                  <button
                    key={i}
                    className={`gen-strip-thumb ${i === selectedIdx ? 'on' : ''}`}
                    onClick={() => onSelect(i)}
                    title={`候选 ${i + 1}`}
                  >
                    {im.image_base64 ? (
                      <img src={im.image_base64} alt={`候选 ${i + 1}`} />
                    ) : (
                      <span className="dim">#{i + 1}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : showLibrary ? (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="stage-tabs">
                <span className="lib-title">提示词词库</span>
                <span className="meta dim">已选 {tags.length}</span>
              </div>
              <div className="stage-info">
                <input
                  className="text-input lib-search"
                  placeholder="搜索标签…"
                  value={libQuery}
                  onChange={(e) => setLibQuery(e.target.value)}
                />
                <button className="btn sm primary" onClick={() => setShowLibrary(false)}>
                  完成
                </button>
              </div>
            </div>
            <div className="lib-body">
              {!libQ && (
                <div className="lib-cats">
                  <button
                    className={`lib-cat ${libCat === FAV_CAT ? 'on' : ''}`}
                    onClick={() => setLibCat(FAV_CAT)}
                  >
                    ★ 收藏{favorites.length ? ` (${favorites.length})` : ''}
                  </button>
                  <button
                    className={`lib-cat ${libCat === CUSTOM_CAT ? 'on' : ''}`}
                    onClick={() => setLibCat(CUSTOM_CAT)}
                  >
                    我的标签{customTags.length ? ` (${customTags.length})` : ''}
                  </button>
                  <div className="lib-cat-sep" />
                  {PROMPT_CATEGORIES.map((c) => (
                    <button
                      key={c.name}
                      className={`lib-cat ${c.name === libCat ? 'on' : ''}`}
                      onClick={() => setLibCat(c.name)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="lib-main">
                {libQ && (
                  <div className="lib-result-head dim">
                    搜索 “{libQuery.trim()}” · {libResults.length} 个结果
                  </div>
                )}
                {!libQ && libCat === CUSTOM_CAT && (
                  <div className="lib-add">
                    <input
                      className="text-input"
                      placeholder="输入自定义标签，回车加入词库"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addCustomTag()
                        }
                      }}
                    />
                    <button className="btn sm" onClick={addCustomTag}>
                      添加
                    </button>
                  </div>
                )}
                {libResults.length ? (
                  <div className="lib-tags">
                    {libResults.map((t) => {
                      const v = tagValue(t)
                      const on = tags.some((x) => x.text === v)
                      const fav = favorites.includes(v)
                      const isCustom = customTags.includes(v)
                      return (
                        <span key={v} className={`lib-tag ${on ? 'on' : ''}`}>
                          <button
                            type="button"
                            className="lib-tag-main"
                            onClick={() => toggleTag(v)}
                            title={on ? '点击移除' : '点击添加'}
                          >
                            {t.label}
                          </button>
                          <button
                            type="button"
                            className={`lib-tag-fav ${fav ? 'on' : ''}`}
                            onClick={() => toggleFavorite(v)}
                            title={fav ? '取消收藏' : '收藏'}
                          >
                            ★
                          </button>
                          {isCustom && (
                            <button
                              type="button"
                              className="lib-tag-del"
                              onClick={() => removeCustomTag(v)}
                              title="从词库删除"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <div className="lib-empty dim">
                    {libCat === FAV_CAT
                      ? '还没有收藏的标签，点标签右侧的 ★ 即可收藏'
                      : libCat === CUSTOM_CAT
                        ? '还没有自定义标签，在上方输入框添加'
                        : '没有匹配的标签'}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : hasGallery ? (
          <div className="stage">
            <div className="stage-toolbar">
              <div className="segmented">
                <button className="on">
                  生成原图{images.length > 0 ? `（${images.length}）` : ''}
                </button>
              </div>
              <div className="stage-info">
                {images.length > 0 && (
                  <>
                    <span className="meta dim">
                      {batchBusy ? batchMsg || '批量导出中…' : `已选 ${picked.length}/${images.length}`}
                    </span>
                    <button className="btn sm" onClick={toggleSelectAll} disabled={batchBusy}>
                      {picked.length === images.length ? '清除' : '全选'}
                    </button>
                    <button
                      className="btn sm primary"
                      disabled={picked.length === 0 || batchBusy}
                      onClick={onBatchExport}
                    >
                      {batchBusy ? '导出中…' : `批量导出（${picked.length}）`}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="viewport">
              {generating && (
                <div className="loading progress">
                  <div className="progress-msg">
                    {genProgress || '生成中…（首次较慢，约 10–60 秒）'}
                  </div>
                  <div className="progress-sub dim">详细进度见顶栏「终端」</div>
                </div>
              )}
              {!generating && genError && <div className="err">{genError}</div>}
              {!generating && !genError && images.length > 0 && (
                <div className="gen-grid">
                  {images.map((im, i) => (
                    <div className="gen-cell" key={i}>
                      <button
                        className={`gen-thumb ${picked.includes(i) ? 'picked' : ''}`}
                        onClick={() => onSelect(i)}
                        title={`候选 ${i + 1}（点击进入编辑）`}
                      >
                        {im.image_base64 ? (
                          <img src={im.image_base64} alt={`候选 ${i + 1}`} />
                        ) : (
                          <span className="dim">#{i + 1}</span>
                        )}
                      </button>
                      <label
                        className="gen-pick"
                        title="勾选以批量导出"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={picked.includes(i)}
                          onChange={() => togglePick(i)}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="empty">
            <div className="empty-art" />
            <h2>AI 生图 → 完美像素化</h2>
            {hasAccounts ? (
              <>
                <p>在右侧输入提示词，或从词库点选标签，一键生成候选图</p>
                <button className="btn" onClick={() => setShowLibrary(true)}>
                  ＋ 打开提示词词库
                </button>
              </>
            ) : (
              <p className="dim">还没有账号，请先到「账号」页添加并登录即梦 / 豆包</p>
            )}
          </div>
        )}
      </main>

      <aside className="inspector">
        {mode === 'edit' ? (
          <>
            <div className="section">
              <button className="btn block" onClick={backToGallery}>
                ← 返回候选（{images.length}）
              </button>
            </div>

            <div className="section">
              <div className="section-title">操作</div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={doMatte}
                  disabled={!matteReady}
                  onChange={(e) => setDoMatte(e.target.checked)}
                />
                <span>抠图去背景（输出透明 PNG）</span>
              </label>
              {!matteReady && <span className="hint-line">未检测到 rembg，暂不可抠图</span>}
            </div>

            {doMatte && matteReady && (
              <>
                <div className="section">
                  <div className="section-title">抠图模型</div>
                  <select
                    className="select"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
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
                    <span>边缘精修(更慢，发丝更好)</span>
                  </label>
                </div>

                <div className="section">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={decon}
                      onChange={(e) => setDecon(e.target.checked)}
                    />
                    <span>去色边(消除边缘背景色溢出)</span>
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
              </>
            )}

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
                <span className="section-title">导出倍数</span>
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
              <button className="btn primary block" disabled={!result || editBusy} onClick={onExport}>
                {doMatte ? `导出透明 PNG（${zoom}×）` : `导出像素 PNG（${zoom}×）`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="section">
              <div className="section-title">账号</div>
              {hasAccounts ? (
                <select
                  className="select"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {PLATFORM_LABEL[a.platform]} · {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="dim small">无账号。请到「账号」页添加。</p>
              )}
            </div>

            <div className="section">
              <div className="row">
                <span className="section-title">提示词</span>
                <div className="prompt-tools">
                  <span className="dim">{tags.length} 个标签</span>
                  {(tags.length > 0 || draft.trim()) && (
                    <button type="button" className="link-btn" onClick={clearPrompt}>
                      清空
                    </button>
                  )}
                </div>
              </div>
              <TagPromptInput
                tags={tags}
                onTagsChange={setTags}
                draft={draft}
                onDraftChange={setDraft}
                placeholder="例如：像素风、橘猫、纯色背景…"
              />
              <button
                type="button"
                className={`btn sm block lib-open ${showLibrary ? 'on' : ''}`}
                onClick={() => setShowLibrary((v) => !v)}
              >
                {showLibrary ? '关闭词库' : '＋ 从词库选择标签'}
              </button>
            </div>

            <div className="section">
              <button
                className="btn primary block"
                disabled={status !== 'ready' || generating || !hasAccounts}
                onClick={onGenerate}
              >
                {generating ? '生成中…' : '生成'}
              </button>
            </div>

            {images.length > 0 && (
              <div className="section">
                <p className="dim small">
                  共 {images.length} 张候选。点击画布中任意一张，进入「抠图 / 完美像素化」编辑。
                </p>
              </div>
            )}
          </>
        )}
      </aside>
    </>
  )
}
