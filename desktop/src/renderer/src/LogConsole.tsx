import { useEffect, useRef, useState } from 'react'
import { getLogs, type LogEntry } from './api'

const LEVEL_DOT: Record<string, string> = {
  info: '·',
  ok: '✓',
  warn: '!',
  error: '✕'
}

interface LogConsoleProps {
  open: boolean
  onClose: () => void
}

export default function LogConsole({ open, onClose }: LogConsoleProps): React.JSX.Element | null {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const sinceRef = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const r = await getLogs(sinceRef.current)
      if (!alive) return
      if (r.logs && r.logs.length) {
        sinceRef.current = r.seq
        setLogs((prev) => [...prev, ...r.logs].slice(-300))
      }
    }
    const id = setInterval(tick, 1200)
    tick()
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [logs, open])

  if (!open) return null

  return (
    <div className="console open">
      <div className="console-bar" onClick={onClose}>
        <span className="console-title">后端日志</span>
        <span className="console-meta">{logs.length}</span>
        <div className="console-actions">
          <button
            className="console-clear"
            onClick={(e) => {
              e.stopPropagation()
              setLogs([])
            }}
          >
            清空
          </button>
          <span className="console-toggle">收起 ▾</span>
        </div>
      </div>
      <div className="console-body" ref={bodyRef}>
        {logs.length === 0 && <div className="console-empty">暂无日志</div>}
        {logs.map((l) => (
          <div key={l.seq} className={`log log-${l.level}`}>
            <span className="log-t">{new Date(l.ts * 1000).toLocaleTimeString()}</span>
            <span className="log-lv">{LEVEL_DOT[l.level] || '·'}</span>
            <span className="log-m">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
