// BottomBar：Sidebar 左下角底栏（用户提供的图片底栏形态：头像 + 用户名 +
// Lite 标签 + 齿轮）。齿轮打开设置面板（SettingsDialog）。

type Props = {
  onOpenSettings: () => void
}

export default function BottomBar({ onOpenSettings }: Props) {
  return (
    <div
      className="border-t p-2 flex items-center gap-2"
      style={{ borderColor: 'var(--border)' }}
    >
      <div
        className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        A
      </div>
      <span className="text-sm font-medium truncate">agent-shell</span>
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full border"
        style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
      >
        Lite
      </span>
      <div className="flex-1" />
      <button
        className="p-1.5 rounded-md hover:opacity-80"
        style={{ color: 'var(--text-dim)' }}
        title="设置"
        onClick={onOpenSettings}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  )
}
