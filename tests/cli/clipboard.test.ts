// v0.26 Wave A — 剪贴板出口单测。spawn 全部 mock（注入 ClipboardSpawn），
// 永不真碰系统剪贴板。覆盖：文本走 stdin、linux 候选链（xclip 失败 →
// wl-copy）、全部失败 → 干净错误、spawn 抛错 / 非零退出 / error 事件。

import { describe, expect, it } from 'vitest'

import {
  copyToClipboard,
  type ClipboardChild,
  type ClipboardSpawn,
} from '../../cli/commands/clipboard.js'

/** 可编排结果的假子进程：stdin 记录写入；error/close 由测试手动触发。 */
const fakeChild = (): ClipboardChild & {
  emitError: (e: Error) => void
  emitClose: (code: number | null) => void
  stdinError: (e: Error) => void
  written: string[]
} => {
  const written: string[] = []
  const errorCbs: ((e: Error) => void)[] = []
  const closeCbs: ((code: number | null) => void)[] = []
  const stdinErrorCbs: ((e: Error) => void)[] = []
  const child = {
    written,
    stdin: {
      write: (chunk: string) => {
        written.push(chunk)
      },
      end: () => {},
      on: (_ev: 'error', cb: (e: Error) => void) => {
        stdinErrorCbs.push(cb)
      },
    },
    on: (ev: 'error' | 'close', cb: (a: never) => void) => {
      if (ev === 'error') errorCbs.push(cb as (e: Error) => void)
      else closeCbs.push(cb as (code: number | null) => void)
    },
    emitError: (e: Error) => errorCbs.forEach((cb) => cb(e)),
    emitClose: (code: number | null) => closeCbs.forEach((cb) => cb(code)),
    stdinError: (e: Error) => stdinErrorCbs.forEach((cb) => cb(e)),
  }
  return child as unknown as ClipboardChild & typeof child
}

describe('copyToClipboard (mocked spawn)', () => {
  it('把文本写进候选命令的 stdin（close 0 = 成功）', async () => {
    const child = fakeChild()
    const spawnFn: ClipboardSpawn = () => child
    const pending = copyToClipboard('hello 世界', spawnFn)
    child.emitClose(0)
    await pending
    expect(child.written).toEqual(['hello 世界'])
  })

  it('首个候选失败（非零码）→ 尝试下一个（linux 链 xclip → wl-copy）', async () => {
    const xclip = fakeChild()
    const wlcopy = fakeChild()
    const cmds: string[] = []
    const spawnFn: ClipboardSpawn = (cmd) => {
      cmds.push(cmd)
      return cmd === 'xclip' ? xclip : wlcopy
    }
    const pending = copyToClipboard('text', spawnFn, 'linux')
    xclip.emitClose(1)
    await Promise.resolve() // 让拒绝续体跑起来、第二个候选的 copyVia 挂上
    wlcopy.emitClose(0)
    await pending
    expect(cmds).toEqual(['xclip', 'wl-copy'])
    expect(wlcopy.written).toEqual(['text'])
  })

  it('全部候选失败 → 干净错误（列出尝试过的命令）', async () => {
    const spawnFn: ClipboardSpawn = () => {
      const c = fakeChild()
      queueMicrotask(() => c.emitClose(1))
      return c
    }
    await expect(copyToClipboard('x', spawnFn, 'linux')).rejects.toThrow(
      /clipboard unavailable.*xclip.*wl-copy/,
    )
  })

  it("spawn 'error' 事件同样收敛为失败", async () => {
    const child = fakeChild()
    const spawnFn: ClipboardSpawn = () => child
    const pending = copyToClipboard('x', spawnFn)
    child.emitError(new Error('ENOENT'))
    await expect(pending).rejects.toThrow(/clipboard command ".*" failed: ENOENT/)
  })
})
