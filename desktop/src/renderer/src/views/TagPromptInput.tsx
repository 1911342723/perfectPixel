import { useRef, useState, type KeyboardEvent, type ClipboardEvent } from 'react'
import { clampWeight, type PromptTag } from './promptPresets'

/** 标签之间的分隔符：英文逗号 / 中文逗号 / 换行。 */
const SEPARATORS = /[,，\n]+/

/** 把一段原始文本切成去空后的标签文本数组。 */
export function splitTags(raw: string): string[] {
  return raw
    .split(SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean)
}

interface Props {
  tags: PromptTag[]
  onTagsChange: (tags: PromptTag[]) => void
  /** 当前未提交的输入文本（受控，便于父级在「生成」时一并收集）。 */
  draft: string
  onDraftChange: (draft: string) => void
  placeholder?: string
}

/**
 * Stable Diffusion 风格的标签式提示词输入框：
 * - 输入文本后按 回车 / 逗号 固化成一个标签 chip（自动去重）
 * - 每个 chip 可点 × 移除；输入框为空时按退格删最后一个
 * - chip 可拖拽排序；悬停出现 − / + 微调权重（权重≠1 时以 (文本:权重) 形式拼入）
 */
export default function TagPromptInput({
  tags,
  onTagsChange,
  draft,
  onDraftChange,
  placeholder
}: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragFrom = useRef<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const addTags = (raw: string): void => {
    const parts = splitTags(raw)
    if (!parts.length) return
    const next = [...tags]
    for (const p of parts) if (!next.some((t) => t.text === p)) next.push({ text: p, weight: 1 })
    onTagsChange(next)
  }

  const commitDraft = (): void => {
    if (draft.trim()) {
      addTags(draft)
      onDraftChange('')
    }
  }

  const removeAt = (i: number): void => {
    onTagsChange(tags.filter((_, idx) => idx !== i))
  }

  const bumpWeight = (i: number, delta: number): void => {
    onTagsChange(
      tags.map((t, idx) => (idx === i ? { ...t, weight: clampWeight(t.weight + delta) } : t))
    )
  }

  const reorder = (from: number, to: number): void => {
    if (from === to) return
    const next = [...tags]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onTagsChange(next)
  }

  const resetDrag = (): void => {
    dragFrom.current = null
    setDragIdx(null)
    setOverIdx(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      commitDraft()
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      e.preventDefault()
      removeAt(tags.length - 1)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text')
    if (SEPARATORS.test(text)) {
      e.preventDefault()
      addTags(`${draft}${text}`)
      onDraftChange('')
    }
  }

  return (
    <div className="tag-input" onClick={() => inputRef.current?.focus()}>
      {tags.map((t, i) => (
        <span
          key={`${t.text}-${i}`}
          className={`tag-chip${dragIdx === i ? ' dragging' : ''}${
            overIdx === i && dragIdx !== i ? ' drop-over' : ''
          }`}
          draggable
          onDragStart={(e) => {
            dragFrom.current = i
            setDragIdx(i)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            e.preventDefault()
            if (overIdx !== i) setOverIdx(i)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (dragFrom.current != null) reorder(dragFrom.current, i)
            resetDrag()
          }}
          onDragEnd={resetDrag}
          title={`${t.text}${t.weight !== 1 ? ` · 权重 ${t.weight.toFixed(1)}` : ''} · 拖动排序`}
        >
          <button
            type="button"
            className="tag-wt-btn"
            title="降低权重"
            onClick={(e) => {
              e.stopPropagation()
              bumpWeight(i, -0.1)
            }}
          >
            −
          </button>
          <span className="tag-chip-label">{t.text}</span>
          {t.weight !== 1 && <span className="tag-wt">{t.weight.toFixed(1)}</span>}
          <button
            type="button"
            className="tag-wt-btn"
            title="提高权重"
            onClick={(e) => {
              e.stopPropagation()
              bumpWeight(i, 0.1)
            }}
          >
            +
          </button>
          <button
            type="button"
            className="tag-chip-x"
            title="移除"
            onClick={(e) => {
              e.stopPropagation()
              removeAt(i)
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="tag-input-field"
        value={draft}
        placeholder={tags.length ? '继续添加…' : placeholder || '输入后回车成为标签'}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commitDraft}
      />
    </div>
  )
}
