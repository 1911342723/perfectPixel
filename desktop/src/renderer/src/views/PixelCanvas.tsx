import { useEffect, useRef, useState } from 'react'

interface PixelCanvasProps {
  src: string
  baseW: number
  baseH: number
  pixelated?: boolean
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** 无限画布：Ctrl+滚轮以鼠标为中心缩放、左键拖动平移；图层 absolute，不参与父级布局。 */
export default function PixelCanvas({
  src,
  baseW,
  baseH,
  pixelated = true
}: PixelCanvasProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })

  // 初始：把图居中并适配到容器
  const fitToView = (): void => {
    const el = ref.current
    if (!el || !baseW || !baseH) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    const fit = Math.min((cw - 56) / baseW, (ch - 56) / baseH)
    const s = fit > 0 ? fit : 1
    setView({ scale: s, x: (cw - baseW * s) / 2, y: (ch - baseH * s) / 2 })
  }

  useEffect(fitToView, [src, baseW, baseH])

  // 用 native 监听 wheel，passive:false 才能 preventDefault（阻止 Electron 整页缩放）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.0016)
      setView((v) => {
        const ns = clamp(v.scale * factor, 0.05, 60)
        const k = ns / v.scale
        return { scale: ns, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
      })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const onMouseDown = (e: React.MouseEvent): void => {
    dragging.current = true
    last.current = { x: e.clientX, y: e.clientY }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    if (!dragging.current) return
    const dx = e.clientX - last.current.x
    const dy = e.clientY - last.current.y
    last.current = { x: e.clientX, y: e.clientY }
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }
  const endDrag = (): void => {
    dragging.current = false
  }

  return (
    <div
      className="pcanvas"
      ref={ref}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onDoubleClick={fitToView}
    >
      <img
        src={src}
        draggable={false}
        alt="canvas"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: baseW,
          height: baseH,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: '0 0',
          imageRendering: pixelated ? 'pixelated' : 'auto',
          display: 'block',
          boxShadow: '0 8px 30px var(--shadow-soft)'
        }}
      />
      <div className="pcanvas-hint">Ctrl + 滚轮缩放 · 拖动平移 · 双击复位</div>
    </div>
  )
}
