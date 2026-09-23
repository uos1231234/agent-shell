/**
 * 配置服务 — 用户注册模型服务商的 json 文档读写。
 *
 * 文件位置：~/.agent-shell/providers.json（AGENT_SHELL_HOME 或
 * resolveConfigPath 的 homeDir/configPath 参数可覆盖）。
 */

export * from './types.js'
export * from './paths.js'
export * from './load.js'
export * from './write.js'
// v0.32: 内置模型思考能力表（保守方案：未知模型不发思考字段）。
export * from './model-capabilities.js'
// v0.25: 宿主功能配置（~/.databus/settings.json）——家目录归属见模块头注释。
export * from './databus-settings.js'
