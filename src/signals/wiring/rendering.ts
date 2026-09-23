// v0.21 Signal Gate — rendering 接线器。
//
// 落实用户拍板的信号顺序：RenderingSignalBus 先给 Signal Gate，Gate 再给
// 渲染基座。本接线器：
//   1. 订阅 bus.onSignal —— Gate 是 artifact 信号的第一个观察者；
//   2. 把 ArtifactSignal 转成 Gate 出站信号（artifact，带 handle 信息），
//      前端据此显示产物卡/tab；
//   3. 把同一信号转发给 base.handleSignal（渲染 → 存储 → onArtifact 广播）
//      —— 装配时 base 以 autoSubscribe:false 创建，这里是唯一入口。
//
// ArtifactSignal 两种形态的映射：
//   - markdown 原文：handle 尚未生成（渲染发生在 base.handleSignal 内），
//     先发一个 title/source 摘要信号让前端知道"有产物在渲染"；
//   - artifact-ref：已存储的 html，handle 信息确定（id/title/source）。
//
// 前端拿到 artifact 信号后经 command('artifact.get') 拉 HTML（gate 的
// getArtifact handler 由装配层接到 base.getHtml）。

import type { ArtifactSignal, RenderingSignalBus } from '../../rendering/signal-bus.js'
import type { RenderingBase } from '../../rendering/base.js'
import type { SignalGate } from '../index.js'

export type GateRenderingWiringDeps = {
  gate: SignalGate
  bus: RenderingSignalBus
  base: RenderingBase
  getSessionId: () => string
}

export const wireRenderingToGate = (deps: GateRenderingWiringDeps): (() => void) => {
  const { gate, bus, base } = deps

  const unsubscribe = bus.onSignal((signal: ArtifactSignal) => {
    const sessionId = deps.getSessionId()
    // 1) 出站：前端可见的 artifact 信号（先于渲染完成——markdown 形态时
    //    handle 以"待渲染"占位，前端等后续 artifact-ref 或直接拉取）。
    if (signal.kind === 'artifact-ref') {
      gate.emit({
        kind: 'artifact',
        sessionId,
        handle: {
          id: signal.artifactId,
          kind: signal.mime === 'text/markdown' ? 'markdown' : 'html',
          title: signal.title,
          source: signal.source,
          at: Date.now(),
        },
      })
    }
    // 2) 转发渲染基座（渲染 → 存储 → onArtifact 广播）。markdown 形态在此
    //    完成 md → HTML → ArtifactStore，随后的 onArtifact 事件里带最终
    //    handle —— 装配层通常还会把 base.onArtifact 也桥到 gate（见 below）。
    base.handleSignal(signal)
  })

  // base.onArtifact（渲染完成的最终 handle）→ gate artifact 信号。
  // markdown 形态的信号在这里带上真实 handle 补发一次（id 已确定）。
  const unsubscribeArtifact = base.onArtifact((handle) => {
    gate.emit({ kind: 'artifact', sessionId: deps.getSessionId(), handle })
  })

  return () => {
    unsubscribe()
    unsubscribeArtifact()
  }
}
