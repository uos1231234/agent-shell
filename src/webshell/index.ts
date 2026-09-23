// v0.21 Web Shell — public barrel。
//
// 宿主（CLI / 未来桌面壳）只应 import 本文件：
//   const gate = createSignalGate({ handlers })
//   const server = await createWebShellServer({ gate, distDir })
//   console.log(server.url)   // http://127.0.0.1:<port>/#token=<token>

export { createWebShellServer, type WebShellServer, type WebShellServerOptions } from './server.js'
export { createWebShellAuth, extractWsToken, WS_BEARER_PROTOCOL_PREFIX, type WebShellAuth } from './auth.js'
export { createWebShellStream, type WebShellStream } from './stream.js'
// v0.26: readWorkspaceEntry 迁入 src/host（宿主装配层不得依赖 web 传输层，
// 方向只能 webshell → host 的向后兼容 re-export）。
export { readWorkspaceEntry } from '../host/workspace-read.js'
