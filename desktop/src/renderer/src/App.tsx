import { useEffect, useState } from 'react'
import { waitForHealth } from './api'
import SingleView from './views/SingleView'
import MattingView from './views/MattingView'
import VideoView from './views/VideoView'
import BatchView from './views/BatchView'
import GenerateView from './views/GenerateView'
import AccountsView from './views/AccountsView'
import SettingsView from './views/SettingsView'
import LogConsole from './LogConsole'
import type { Status } from './views/common'

type Tab = 'single' | 'matting' | 'video' | 'batch' | 'generate' | 'accounts' | 'settings'
type Theme = 'light' | 'dark'

const NAV: { id: Tab; label: string; enabled: boolean }[] = [
  { id: 'single', label: '单图', enabled: true },
  { id: 'matting', label: '一键抠图', enabled: true },
  { id: 'video', label: '视频 / GIF', enabled: true },
  { id: 'batch', label: '批量', enabled: true },
  { id: 'generate', label: 'AI 生图', enabled: true },
  { id: 'accounts', label: '账号', enabled: true }
]

const GearIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const SunIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

const MoonIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

const TerminalIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<Status>('connecting')
  const [tab, setTab] = useState<Tab>('single')
  const [toast, setToast] = useState<string | null>(null)
  const [showConsole, setShowConsole] = useState(false)
  const [prevTab, setPrevTab] = useState<Tab>('single')
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('pp-theme') as Theme) || 'light'
  )

  const openSettings = (): void => {
    if (tab !== 'settings') setPrevTab(tab)
    setTab('settings')
  }

  const showToast = (m: string): void => {
    setToast(m)
    setTimeout(() => setToast(null), 2400)
  }

  useEffect(() => {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
    localStorage.setItem('pp-theme', theme)
    window.ppApi.setTitleBarTheme?.(theme === 'dark')
  }, [theme])

  useEffect(() => {
    waitForHealth().then((r) => setStatus(r.ok ? 'ready' : 'error'))
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-name">完美像素</span>
          <span className="brand-sub">PerfectPixel</span>
        </div>
        <button
          className={`term-toggle ${showConsole ? 'on' : ''}`}
          onClick={() => setShowConsole((v) => !v)}
          title="后端日志终端"
        >
          <TerminalIcon />
          <span>终端</span>
        </button>
      </header>

      <div className={`body ${tab === 'settings' ? 'settings-mode' : ''}`}>
        {tab === 'settings' ? (
          <SettingsView
            status={status}
            showToast={showToast}
            theme={theme}
            setTheme={setTheme}
            onBack={() => setTab(prevTab === 'settings' ? 'single' : prevTab)}
          />
        ) : (
          <>
            <nav className="sidebar">
              {NAV.map((n) => (
                <button
                  key={n.id}
                  className={`nav-item ${n.id === tab ? 'active' : ''}`}
                  disabled={!n.enabled}
                  onClick={() => n.enabled && setTab(n.id)}
                >
                  <span>{n.label}</span>
                  {!n.enabled && <span className="soon">即将</span>}
                </button>
              ))}

              <div className="sidebar-bottom">
                <button
                  className="nav-item nav-action"
                  onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                  title="切换浅色 / 深色"
                >
                  <span className="nav-ico">{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</span>
                  <span>{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
                </button>
                <button className="nav-item nav-action" onClick={openSettings}>
                  <span className="nav-ico">
                    <GearIcon />
                  </span>
                  <span>设置</span>
                </button>
              </div>
            </nav>

            {tab === 'single' && <SingleView status={status} showToast={showToast} />}
            {tab === 'matting' && <MattingView status={status} showToast={showToast} />}
            {tab === 'video' && <VideoView status={status} showToast={showToast} />}
            {tab === 'batch' && <BatchView status={status} showToast={showToast} />}
            {tab === 'generate' && <GenerateView status={status} showToast={showToast} />}
            {tab === 'accounts' && <AccountsView status={status} showToast={showToast} />}
          </>
        )}
      </div>

      <LogConsole open={showConsole} onClose={() => setShowConsole(false)} />

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
