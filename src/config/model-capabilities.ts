/**
 * 内置模型思考能力表（v0.32）——KNOWN_MODELS + resolveModelReasoning。
 *
 * 设计（v0.32 计划 §4 原则 2/4，用户拍板保守方案）：未知且未声明的模型
 * **不发任何思考字段**（AtomCode 白名单 + KimiCode 能力目录 + dsh 发前校验
 * 三家同款语义）——乐观注入在严格网关上的失败模式（每轮 400 且错误格式
 * 不匹配自愈窄匹配 → 会话全废）不可接受。
 *
 * 表内条目只收 [已验证] 实测（ARK 探针 2026-09-09，非流式 min 成本请求）：
 *   - deepseek-v4-flash：reasoning_effort low/medium/high 全 200；off 直发
 *     400（InvalidParameter）；thinking:{type:'disabled'} 200 且思考归零 →
 *     off 的唯一正确 wire 编码是 thinking:disabled（装配层既有实现）。
 *   - glm-5.3-flash：thinking:{type:'disabled'} → 400 "not supported by
 *     this model"（always-thinking 不可关）；reasoning_effort 虽 200 但
 *     档位语义不可靠（high/low 思考为 0，与档位无关）。
 * 用户可在 providers.json models[].reasoning 显式声明覆盖本表。
 */

import type { ModelReasoning } from './types.js'

/** deepseek-v4 系：支持开/关 + effort 档位。 */
const DEEPSEEK_V4: ModelReasoning = { efforts: ['max', 'high', 'low', 'off'], defaultEffort: 'max' }

/** glm-5 系：always-thinking（不可关断），档位语义未验证——只声明不可关。 */
const GLM5: ModelReasoning = { efforts: ['max', 'high', 'low'], defaultEffort: 'max' }

export const KNOWN_MODELS: ReadonlyArray<{ match: RegExp; reasoning: ModelReasoning }> = [
  { match: /^deepseek-v4/i, reasoning: DEEPSEEK_V4 },
  { match: /^glm-5/i, reasoning: GLM5 },
]

/**
 * 解析模型的有效思考能力。declared（providers.json models[].reasoning）优先；
 * 否则按内置表模型名前缀匹配；未知 → undefined（调用方据此不发思考字段、
 * UI 不渲染档位组）。
 */
export const resolveModelReasoning = (
  modelId: string,
  declared?: ModelReasoning | undefined,
): ModelReasoning | undefined => {
  if (declared !== undefined) return declared
  return KNOWN_MODELS.find((k) => k.match.test(modelId))?.reasoning
}
