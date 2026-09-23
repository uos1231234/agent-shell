// v0.26 Wave A — 会话 picker 增强单测：fuzzyMatch 计分 / formatRelativeTime
// 边界 / SessionPickerOverlay 过滤状态机（键入即过滤、Backspace、Ctrl-U、
// 过滤后导航与选择、活跃标记、外来分区拒绝）。纯函数 + 浮层直驱（无屏幕）。

import { describe, expect, it } from 'vitest'

import {
  SessionPickerOverlay,
  formatRelativeTime,
  fuzzyMatch,
  type SessionPickerIo,
} from '../../cli/picker.js'
import type { SessionInfo } from '../../src/im/session/types.js'

const info = (id: string, title: string, lastActiveAt = 0, workDir?: string): SessionInfo => ({
  id,
  title,
  workingAgentId: 'main',
  createdAt: 0,
  lastActiveAt,
  turnCount: 1,
  layer: 'M0',
  snapshotExpired: false,
  ...(workDir !== undefined ? { workDir } : {}),
})

// ---------------------------------------------------------------------------
// fuzzyMatch
// ---------------------------------------------------------------------------

describe('fuzzyMatch', () => {
  it('空查询匹配一切（0 分）', () => {
    expect(fuzzyMatch('', 'anything')).toBe(0)
  })

  it('子序列命中返回正分；非子序列返回 null', () => {
    expect(fuzzyMatch('abc', 'a1b2c3')).toBeGreaterThan(0)
    expect(fuzzyMatch('ac', 'abc')).toBeGreaterThan(0)
    expect(fuzzyMatch('ca', 'abc')).toBeNull()
    expect(fuzzyMatch('xyz', 'abc')).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(fuzzyMatch('ABC', 'abc')).toBe(fuzzyMatch('abc', 'abc'))
    expect(fuzzyMatch('Ses', 'SessionPicker')).toBeGreaterThan(0)
  })

  it('连续命中得分高于离散命中（离散例的命中都在词中，无词首加分）', () => {
    const consecutive = fuzzyMatch('ses', 'sessions')!
    const scattered = fuzzyMatch('ses', 'houses')!
    expect(consecutive).toBeGreaterThan(scattered)
  })

  it('词首/文本头命中加分', () => {
    const head = fuzzyMatch('s', 'sessions')!
    const middle = fuzzyMatch('s', 'cases')!
    expect(head).toBeGreaterThan(middle)
  })

  it('重复字符耗尽后失败（同一文本位不能消费两次）', () => {
    expect(fuzzyMatch('sss', 'ses')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-08T12:00:00Z')

  it('刚刚（< 1 分钟；未来时间戳也归刚刚）', () => {
    expect(formatRelativeTime(now, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 59_999, now)).toBe('刚刚')
    expect(formatRelativeTime(now + 5_000, now)).toBe('刚刚')
  })

  it('N 分钟前（1 分钟到 1 小时）', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 分钟前')
    expect(formatRelativeTime(now - 3_599_999, now)).toBe('59 分钟前')
  })

  it('N 小时前（1 小时到 1 天）', () => {
    expect(formatRelativeTime(now - 3_600_000, now)).toBe('1 小时前')
    expect(formatRelativeTime(now - 86_399_999, now)).toBe('23 小时前')
  })

  it('N 天前（1 天到 30 天）', () => {
    expect(formatRelativeTime(now - 86_400_000, now)).toBe('1 天前')
    expect(formatRelativeTime(now - 29 * 86_400_000, now)).toBe('29 天前')
  })

  it('超过 30 天 → 日期（YYYY-MM-DD）', () => {
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toBe('2026-08-09')
  })
})

// ---------------------------------------------------------------------------
// SessionPickerOverlay 过滤状态机
// ---------------------------------------------------------------------------

describe('SessionPickerOverlay — 过滤状态机', () => {
  /** 每个测试独立的一套回调记录（避免用例间共享状态）。 */
  const makeIo = (entries: readonly SessionInfo[], activeSessionId?: string) => {
    const picked: SessionInfo[] = []
    const foreignPicked: SessionInfo[] = []
    const cancels: number[] = []
    const io: SessionPickerIo = {
      entries,
      workDir: 'D:\\ws',
      ...(activeSessionId !== undefined ? { activeSessionId } : {}),
      onPick: (i) => picked.push(i),
      onForeignPick: (i) => foreignPicked.push(i),
      onCancel: () => {
        cancels.push(1)
      },
    }
    return { io, picked, foreignPicked, cancels }
  }

  it('无查询：分区原序 + 相对时间 + 活跃会话标记', () => {
    const { io } = makeIo(
      [info('a1', '标题甲', 1000, 'D:\\ws'), info('b2', '标题乙', 2000, 'D:\\other')],
      'a1',
    )
    const picker = new SessionPickerOverlay(io)
    const rows = picker.render(80)
    expect(rows[0]).toContain('键入即过滤')
    const joined = rows.join('\n')
    expect(joined).toContain('* 标题甲')
    expect(joined).not.toContain('* 标题乙')
    expect(joined).toContain('回合 1 ·')
    expect(joined).toContain('其他工作区')
    expect(joined).toContain('other') // workDir 尾段
  })

  it('空 title 回落 id 前缀', () => {
    const { io } = makeIo([info('abc12345', '   ', 0, 'D:\\ws')])
    const picker = new SessionPickerOverlay(io)
    expect(picker.render(80).join('\n')).toContain('abc12345')
  })

  it('键入即过滤：文本事件进查询串，行数随之收窄，标题行显示过滤内容', () => {
    const { io } = makeIo([
      info('aaa', 'hook 系统', 0, 'D:\\ws'),
      info('bbb', '数据库迁移', 0, 'D:\\ws'),
      info('ccc', 'hook 渲染', 0, 'D:\\other'),
    ])
    const picker = new SessionPickerOverlay(io)
    picker.handleInput(Buffer.from('hook'))
    const rows = picker.render(80)
    expect(rows[0]).toContain('过滤: hook')
    const joined = rows.join('\n')
    expect(joined).toContain('hook 系统')
    expect(joined).toContain('hook 渲染')
    expect(joined).not.toContain('数据库迁移')
  })

  it('Backspace 删一个字符；Ctrl-U 清空', () => {
    const { io } = makeIo([info('a', '标题', 0, 'D:\\ws')])
    const picker = new SessionPickerOverlay(io)
    picker.handleInput(Buffer.from('ab'))
    expect(picker.render(80)[0]).toContain('过滤: ab')
    picker.handleInput(Buffer.from('\x7f')) // backspace
    expect(picker.render(80)[0]).toContain('过滤: a')
    picker.handleInput(Buffer.from('\x15')) // ctrl+u
    expect(picker.render(80)[0]).toContain('键入即过滤')
  })

  it('无匹配 → （无匹配会话），Enter 不选择', () => {
    const { io, picked, foreignPicked, cancels } = makeIo([info('a', '标题', 0, 'D:\\ws')])
    const picker = new SessionPickerOverlay(io)
    picker.handleInput(Buffer.from('zzzz'))
    expect(picker.render(80).join('')).toContain('（无匹配会话）')
    picker.handleInput(Buffer.from('\r'))
    expect(picked).toHaveLength(0)
    expect(foreignPicked).toHaveLength(0)
    expect(cancels).toHaveLength(0)
  })

  it('过滤后的索引与选择一致；Enter 选中过滤后条目', () => {
    const { io, picked } = makeIo([
      info('aaa', '写文件', 0, 'D:\\ws'),
      info('bbb', '读文件', 0, 'D:\\ws'),
      info('ccc', '删除文件', 0, 'D:\\ws'),
    ])
    const picker = new SessionPickerOverlay(io)
    picker.handleInput(Buffer.from('删'))
    // 匹配唯一：删除文件。Enter 即选中它。
    picker.handleInput(Buffer.from('\r'))
    expect(picked.map((i) => i.id)).toEqual(['ccc'])
  })

  it('过滤不越分区：外来会话选中仍走 onForeignPick（G5 拒绝）', () => {
    const { io, picked, foreignPicked } = makeIo([
      info('here1', '本地任务', 0, 'D:\\ws'),
      info('far1', '远端任务', 0, 'D:\\far'),
    ])
    const picker = new SessionPickerOverlay(io)
    picker.handleInput(Buffer.from('远'))
    picker.handleInput(Buffer.from('\r'))
    expect(foreignPicked.map((i) => i.id)).toEqual(['far1'])
    expect(picked).toHaveLength(0)
  })

  it('Esc 取消（行为不变）', () => {
    const { io, cancels } = makeIo([info('a', 't', 0, 'D:\\ws')])
    const picker = new SessionPickerOverlay(io)
    picker.handleInput(Buffer.from('\x1b'))
    expect(cancels).toHaveLength(1)
  })
})
