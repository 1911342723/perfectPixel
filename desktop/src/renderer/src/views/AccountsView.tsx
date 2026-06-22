import { useCallback, useEffect, useState } from 'react'
import {
  addAccount,
  checkAccount,
  deleteAccount,
  listAccounts,
  loginAccount,
  type Account,
  type Platform
} from '../api'
import type { ViewProps } from './common'

const PLATFORM_LABEL: Record<Platform, string> = { jimeng: '即梦', doubao: '豆包' }
const STATUS_LABEL: Record<string, string> = {
  logged_in: '已登录',
  logged_out: '未登录',
  unknown: '未检测'
}

export default function AccountsView({ status, showToast }: ViewProps): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyMsg, setBusyMsg] = useState('')
  const [addPlatform, setAddPlatform] = useState<Platform>('jimeng')
  const [addName, setAddName] = useState('')
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    const r = await listAccounts()
    if (r.ok) setAccounts(r.accounts)
  }, [])

  useEffect(() => {
    if (status === 'ready') refresh()
  }, [status, refresh])

  const onAdd = async (): Promise<void> => {
    setAdding(true)
    const r = await addAccount(addPlatform, addName.trim() || undefined)
    setAdding(false)
    if (!r.ok) {
      showToast(r.error || '添加失败')
      return
    }
    setAddName('')
    await refresh()
    showToast('已添加账号，请点击「登录」完成首次登录')
  }

  const onLogin = async (acc: Account): Promise<void> => {
    setBusyId(acc.id)
    setBusyMsg(`已用本机 Chrome 打开${PLATFORM_LABEL[acc.platform]}，请在浏览器中完成登录…`)
    const r = await loginAccount(acc.id)
    setBusyId(null)
    setBusyMsg('')
    if (!r.ok) {
      showToast(r.error || '登录失败')
    } else {
      showToast(r.logged_in ? '登录成功' : '未检测到登录态，可稍后重试')
    }
    await refresh()
  }

  const onCheck = async (acc: Account): Promise<void> => {
    setBusyId(acc.id)
    setBusyMsg('检测登录态…')
    const r = await checkAccount(acc.id)
    setBusyId(null)
    setBusyMsg('')
    if (!r.ok) showToast(r.error || '检测失败')
    await refresh()
  }

  const onDelete = async (acc: Account): Promise<void> => {
    setBusyId(acc.id)
    await deleteAccount(acc.id)
    setBusyId(null)
    await refresh()
    showToast('已删除账号')
  }

  return (
    <>
      <main className="canvas">
        {accounts.length === 0 ? (
          <div className="empty">
            <div className="empty-art" />
            <h2>多账号管理 · 即梦 / 豆包</h2>
            <p>添加账号 → 浏览器登录一次 → 之后自动复用，用于 AI 生图</p>
            <p className="dim">每个账号使用独立的 Chrome 资料目录，登录态本地存储、不上传。</p>
          </div>
        ) : (
          <div className="acc-list">
            {busyId && busyMsg && <div className="acc-busy">{busyMsg}</div>}
            {accounts.map((a) => (
              <div className="acc-card" key={a.id}>
                <div className={`acc-badge ${a.platform}`}>{PLATFORM_LABEL[a.platform]}</div>
                <div className="acc-main">
                  <div className="acc-name">{a.name}</div>
                  <div className="acc-meta">
                    <span className={`acc-status ${a.status}`}>
                      {STATUS_LABEL[a.status] || a.status}
                    </span>
                    {a.last_check && <span className="dim"> · 检测于 {a.last_check}</span>}
                  </div>
                </div>
                <div className="acc-actions">
                  <button className="btn sm" disabled={!!busyId} onClick={() => onLogin(a)}>
                    {busyId === a.id ? '处理中…' : '登录'}
                  </button>
                  <button className="btn sm" disabled={!!busyId} onClick={() => onCheck(a)}>
                    检测
                  </button>
                  <button className="btn sm danger" disabled={!!busyId} onClick={() => onDelete(a)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <aside className="inspector">
        <div className="section">
          <div className="section-title">添加账号</div>
          <div className="segmented full">
            {(['jimeng', 'doubao'] as Platform[]).map((p) => (
              <button
                key={p}
                className={addPlatform === p ? 'on' : ''}
                onClick={() => setAddPlatform(p)}
              >
                {PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
          <input
            className="text-input"
            placeholder="账号备注（可选）"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
          />
          <button
            className="btn primary block"
            disabled={status !== 'ready' || adding}
            onClick={onAdd}
          >
            {adding ? '添加中…' : '添加账号'}
          </button>
        </div>

        <div className="section">
          <div className="section-title">使用说明</div>
          <p className="dim small">
            1. 添加后点「登录」，用本机 Chrome 打开网站，手动完成登录（扫码 / 账号密码）。
            <br />
            2. 登录态保存在该账号独立资料目录，之后生图自动复用。
            <br />
            3. 「检测」可校验登录是否仍有效。
          </p>
        </div>

        <div className="spacer" />

        <div className="section">
          <div className="warn-box">
            ⚠️ 仅供个人使用：请遵守即梦 / 豆包服务条款。自动化访问存在风控 / 封号风险，账号自负。
          </div>
        </div>
      </aside>
    </>
  )
}
