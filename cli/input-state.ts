// v0.26 Wave 3 — input state router（plan §3.3, G2 四态聚焦路由）。
//
// 四态：editor（默认）/ approval / ask_user / picker。浮层态（approval /
// ask_user / picker，Wave 4/5 提供真实 handler）整体接管键盘——浮层 handler
// 返回 false 也**不回落**到编辑器（模态语义：浮层态不收命令输入，计划 §3.3）。
//
// 契约说明：
//   - editor 是默认 handler：构造注入或 setEditor() 注册；没有编辑器时
//     route() 是安全 no-op（返回 false，不 throw——调用方（app）负责装配，
//     缺编辑器只意味着"没人消费输入"）。
//   - enter() 一次只有一个浮层；再次 enter 直接替换（排队/顺序由 Wave 4 的
//     审批队列管理，路由器不做策略）。
//   - enter('editor') 是编程错误 → throw（editor 态走 setEditor）。
//   - 数据原样透传（string | Buffer 均可）：编辑器内部自带 normalize +
//     UTF-8 续包，浮层 handler 自己决定如何消费。

export type InputState = 'editor' | 'approval' | 'ask_user' | 'picker'

export interface InputHandler {
  /** Consume a raw stdin chunk. true = fully consumed. */
  handleInput(data: string | Buffer): boolean
}

export class InputRouter {
  private editorHandler: InputHandler | null
  private overlayState: Exclude<InputState, 'editor'> | null = null
  private overlayHandler: InputHandler | null = null

  constructor(editor?: InputHandler) {
    this.editorHandler = editor ?? null
  }

  get state(): InputState {
    return this.overlayState ?? 'editor'
  }

  setEditor(handler: InputHandler): void {
    this.editorHandler = handler
  }

  /** Mount an overlay; it takes over all keys until exitToEditor(). */
  enter(state: InputState, handler: InputHandler): void {
    if (state === 'editor') {
      throw new Error("InputRouter.enter: 'editor' is the default state — use setEditor() to register the editor handler")
    }
    this.overlayState = state
    this.overlayHandler = handler
  }

  exitToEditor(): void {
    this.overlayState = null
    this.overlayHandler = null
  }

  route(data: string | Buffer): boolean {
    if (this.overlayState !== null && this.overlayHandler !== null) {
      return this.overlayHandler.handleInput(data)
    }
    return this.editorHandler?.handleInput(data) ?? false
  }
}
