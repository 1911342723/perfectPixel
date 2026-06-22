import { useEffect, useState } from 'react'
import { getSettings, saveSettings } from '../api'
import { type ViewProps } from './common'

interface SettingsViewProps extends ViewProps {
  theme: 'light' | 'dark'
  setTheme: (t: 'light' | 'dark') => void
  onBack: () => void
}

type Section = 'general' | 'appearance'

const BackArrow = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)

export default function SettingsView({
  status,
  showToast,
  theme,
  setTheme,
  onBack
}: SettingsViewProps): React.JSX.Element {
  const [section, setSection] = useState<Section>('general')
  const [outputDir, setOutputDir] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (status !== 'ready') return
    getSettings().then((r) => {
      if (r.ok && r.settings) setOutputDir(r.settings.output_dir)
      setLoaded(true)
    })
  }, [status])

  const onPick = async (): Promise<void> => {
    const d = await window.ppApi.openDir()
    if (!d) return
    const r = await saveSettings({ output_dir: d })
    if (r.ok && r.settings) {
      setOutputDir(r.settings.output_dir)
      showToast('已保存：生图将输出到该目录')
    } else {
      showToast('保存失败')
    }
  }

  const onOpen = async (): Promise<void> => {
    if (!outputDir) return
    const ok = await window.ppApi.openPath(outputDir)
    if (!ok) showToast('无法打开（目录可能尚未创建，生成一次后再试）')
  }

  return (
    <div className="settings-screen">
      <aside className="settings-nav">
        <button className="settings-back" onClick={onBack}>
          <span className="nav-ico">{BackArrow}</span>
          <span>返回应用</span>
        </button>

        <div className="settings-group-label">通用</div>
        <button
          className={`settings-navitem ${section === 'general' ? 'active' : ''}`}
          onClick={() => setSection('general')}
        >
          常规
        </button>

        <div className="settings-group-label">外观</div>
        <button
          className={`settings-navitem ${section === 'appearance' ? 'active' : ''}`}
          onClick={() => setSection('appearance')}
        >
          主题外观
        </button>
      </aside>

      <main className="settings-content">
        {section === 'general' && (
          <div className="settings-pane">
            <h1>常规</h1>

            <div className="set-section-title">生成图片</div>
            <div className="set-section-desc">AI 生图的结果会保存到这里，设置会持久化、重启不丢失。</div>
            <div className="set-row">
              <div className="set-row-label">
                <div className="set-row-title">保存目录</div>
                <div className="set-row-desc" title={outputDir}>
                  {loaded ? outputDir || '未设置' : '加载中…'}
                </div>
              </div>
              <div className="set-row-control">
                <button className="btn" onClick={onPick} disabled={status !== 'ready'}>
                  选择目录…
                </button>
                <button className="btn" onClick={onOpen} disabled={!outputDir}>
                  打开
                </button>
              </div>
            </div>
          </div>
        )}

        {section === 'appearance' && (
          <div className="settings-pane">
            <h1>主题外观</h1>

            <div className="set-section-title">主题</div>
            <div className="set-section-desc">选择界面的明暗风格，切换后自动保存。</div>
            <div className="choice-row">
              <button
                className={`choice-card ${theme === 'light' ? 'on' : ''}`}
                onClick={() => setTheme('light')}
              >
                <div className="choice-card-main">
                  <div className="choice-card-title">浅色</div>
                  <div className="choice-card-desc">明亮清爽，适合白天</div>
                </div>
                <span className="choice-radio" />
              </button>
              <button
                className={`choice-card ${theme === 'dark' ? 'on' : ''}`}
                onClick={() => setTheme('dark')}
              >
                <div className="choice-card-main">
                  <div className="choice-card-title">深色</div>
                  <div className="choice-card-desc">护眼低光，适合夜间</div>
                </div>
                <span className="choice-radio" />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
