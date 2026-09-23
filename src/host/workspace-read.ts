// v0.24: workspace.read 的宿主侧 fs 实现——工作区是权限边界（用户拍板 52315b1），
// resolve 后必须仍在会话 workDir 内，越界一律拒绝。本模块只做纯 fs 逻辑
// （包含性检查 + 目录列举 / 文件读取 + 截断 + 二进制检测）；会话查找是 web-host
// openHandles 的状态，不在这里——宿主 handler 查到 workDir 后一行委托。
// 放在 src/host（宿主装配层，v0.26 自 src/webshell 迁入——装配层不得依赖 web
// 传输层）而不是 examples/web-host.ts：宿主入口顶层就跑
// main()，测试无法 import；本模块仅依赖 node:fs/promises + node:path。

import { readFile, readdir, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import type { WorkspaceReadResult } from '../signals/types.js'

/** 目录条目上限：目录在前、按名排序后取前 500 条。 */
const MAX_DIR_ENTRIES = 500
/** 文件内容上限（原始字节）：超出截断并置 truncated；size 仍报原始大小。 */
const MAX_FILE_BYTES = 256 * 1024

/**
 * 读取会话工作区内的一个路径（文件内容或目录条目列表）。
 * path='.' 表示工作区根目录（resolve(root, '.') 天然落回 root）。
 * 返回的 path 字段是相对 workDir 的规范形式（'.' 或正斜杠相对路径）。
 */
export const readWorkspaceEntry = async (
  workDir: string,
  path: string,
): Promise<WorkspaceReadResult> => {
  const root = resolve(workDir)
  const full = resolve(root, path)
  // 包含性检查：前缀 + 分隔符边界——/ws 与 /ws-vs-foo 这类同名前缀目录不算内部。
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`path "${path}" escapes the session workspace; only paths inside it are readable`)
  }
  const canonical = full === root ? '.' : relative(root, full).split(sep).join('/')

  const st = await stat(full)
  if (st.isDirectory()) {
    const dirents = await readdir(full, { withFileTypes: true })
    const entries = dirents
      .map((d): { name: string; kind: 'file' | 'dir' } => ({
        name: d.name,
        kind: d.isDirectory() ? 'dir' : 'file',
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
      .slice(0, MAX_DIR_ENTRIES)
    return { path: canonical, kind: 'dir', entries }
  }

  const buf = await readFile(full)
  // 二进制检测在截断之前：整个文件扫 NUL 字节（只看前 256KB 会漏判
  // "文本头部 + 二进制正文"的格式），命中即拒绝，不给前端吐乱码。
  if (buf.includes(0)) {
    throw new Error(`file "${canonical}" appears to be binary; only text files can be displayed`)
  }
  const truncated = buf.length > MAX_FILE_BYTES
  return {
    path: canonical,
    kind: 'file',
    content: (truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf).toString('utf8'),
    ...(truncated ? { truncated: true } : {}),
    size: buf.length,
  }
}
