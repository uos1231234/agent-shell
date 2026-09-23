/**
 * Prompt layer names — 四层配置注入（v0.19 D1）
 *
 * Layers are loaded from广到窄: managed → user → project → local.
 * Higher priority layers override lower ones.
 */
export type PromptLayerName = 'managed' | 'user' | 'project' | 'local'

export type PromptLayer = {
  name: PromptLayerName
  content: string
  priority: number  // 0=managed, 10=user, 20=project, 30=local
}

/**
 * Prompt modes — 三种模式（v0.19 D5）
 *
 * full: 主代理，完整段落
 * minimal: 子代理，省略工具指南和行动导向
 * none: 仅身份行
 */
export type PromptMode = 'full' | 'minimal' | 'none'
