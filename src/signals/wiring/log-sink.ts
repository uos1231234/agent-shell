// v0.21 Signal Gate — log-sink 接线器。
//
// 把结构化 logger 的全局 sink 换成"Gate 广播 + stderr 保留"的组合：
//   logger.setSink(rec => { gate.emit(log 信号); 默认 stderr 输出 })
//
// 注意：logger.setSink 是全局单槽（shared/logger.ts:72）——本接线器接管后，
// 所有 logger 记录都会流经 Gate。这是用户拍板的"前端日志界面"数据源：
// v0.22 的 LogPanel 渲染 log 信号，供用户审查 harness 行为。
//
// 风险控制：sink 里不能再调 logger（会递归）——gate.emit 的内部 warn 走
// console.warn（gate.ts 的实现就是 console.warn，安全）。

import { setSink } from '../../shared/logger.js'
import type { LogRecord } from '../../shared/logger.js'
import type { SignalGate } from '../index.js'

export type GateLogSinkWiringDeps = {
  gate: SignalGate
  /**
   * 组件归属标签（log 信号的 component 字段）。全局 sink 无法从 LogRecord
   * 区分组件（child bindings 混在 fields 里），装配层给一个静态标签。
   */
  component?: string
  /** 是否保留 stderr 输出（默认 true——不破坏既有日志习惯）。 */
  keepStderr?: boolean
}

export const wireLogSinkToGate = (deps: GateLogSinkWiringDeps): void => {
  const keepStderr = deps.keepStderr ?? true
  setSink((rec: LogRecord) => {
    const { ts, level, msg, ...fields } = rec
    deps.gate.emit({
      kind: 'log',
      level,
      msg,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
      ts,
      component: deps.component,
    })
    if (keepStderr) {
      try {
        process.stderr.write(JSON.stringify(rec) + '\n')
      } catch {
        // stderr 写失败（管道关闭等）不递归、不上抛——日志通道永不反噬主流程。
      }
    }
  })
}
