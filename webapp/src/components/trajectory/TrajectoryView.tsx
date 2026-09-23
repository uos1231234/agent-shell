// TrajectoryView：只读事件台账（deepseek 的审计视图）。消费 session-store 的
// timeline——每条信号一行；点击展开完整 detail。与 Chat 视图同源（同一 store）。

import { useSessionStore } from '../../state/session-store'
import { useUiStore } from '../../state/ui-store'

// zustand v5 selector 用 Object.is 比较结果——`?? []` 每次生成新数组会触发
// 无限重渲染（React #185）。空态必须引用稳定常量。
const EMPTY_TIMELINE: ReturnType<typeof useSessionStore.getState>['sessions'][string]['timeline'] = []

const kindColor: Record<string, string> = {
  'assistant.delta': 'var(--accent)',
  'tool.started': 'var(--accent-blue)',
  'tool.result': 'var(--accent-blue)',
  'turn.end': 'var(--warn)',
  artifact: 'var(--accent)',
  approval: 'var(--warn)',
  ask_user: 'var(--warn)',
  log: 'var(--text-dim)',
}

export default function TrajectoryView({ activeSessionId }: { activeSessionId: string }) {
  const timeline = useSessionStore((s) => s.sessions[activeSessionId]?.timeline ?? EMPTY_TIMELINE)
  const setView = useUiStore((s) => s.setView)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">事件轨迹（只读审计台账 · {timeline.length} 条）</span>
        <button className="text-xs underline" style={{ color: 'var(--accent-blue)' }} onClick={() => setView('chat')}>
          返回对话
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="py-1 pr-3 font-normal w-16">seq</th>
              <th className="py-1 pr-3 font-normal w-32">kind</th>
              <th className="py-1 font-normal">detail</th>
            </tr>
          </thead>
          <tbody>
            {timeline.map((e) => (
              <tr key={e.seq} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="py-1.5 pr-3 font-mono" style={{ color: 'var(--text-dim)' }}>
                  {e.seq}
                </td>
                <td className="py-1.5 pr-3 font-mono" style={{ color: kindColor[e.kind] ?? 'var(--text)' }}>
                  {e.kind}
                </td>
                <td className="py-1.5 whitespace-pre-wrap break-all font-mono">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {timeline.length === 0 && (
          <p className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>
            本连接内暂无事件——历史事实在对话视图（history 恢复）。
          </p>
        )}
      </div>
    </div>
  )
}
