// chunk.ts — 大输入切块纯函数（v0.42 gate 会话级切块基础设施）。
//
// 完全由用户决策驱动（2026-09-15 拍板）：
//   - 纯手动：只有进入切块模式的会话才切，日常小消息零影响，不做自动阈值判断。
//   - 字符/字节硬切 + 序号前缀：把超长单条用户输入切成 N 个 40K 分卷，
//     每卷开头加「（资料分卷 n/N）」让模型知道自己在处理第几份。
//   - 每卷独立 user 回合落 canonical → 自然块边界 → G1 逐块触发（用户拍板）。
//
// 本模块是纯函数：无状态、无 IO。谁切、切不切由 gate 的 user.prompt 分支决定。

/**
 * 分卷前缀。放在每卷开头，格式「（资料分卷 n/N）」。前缀本身计入该卷.
 * 长度；若切出的卷极短（输入恰在小块边缘），前缀可能占不少比例，但这是
 * "让模型知道分卷"的最小必要信息，接受。
 */
export const chunkPrefix = (n: number, total: number): string => `（资料分卷 ${n}/${total}）`

// 默认每分卷 token 预算（用户拍板 2026-09-15：40K）。可配（chunkTokens）。
// 与 goal 的 G1 块最小触发（80K）无强耦合——40K 是"尽量轻的每次调用"，
// 两块约摸凑一个 G1；用户明确选了 40K 而非去对齐 80K。
export const DEFAULT_CHUNK_TOKENS = 40_000

/**
 * 把超长输入硬切成若干分卷，每卷带「资料分卷 n/N」前缀。
 *
 * 切割单位：**字符**（CJK 感知的自然单位，1 个中文字符 = 1 个单位）。
 * 选择字符而非计算 token：调用方（gate）在请求边界持有的是用户文本字符串，
 * 没有"这串文本实际多少 token"的先验知识，逐字节算 token 需要额外估算步骤
 * 且可能低估中文。字符硬切是纯确定性的，token 估算留给后续真正的压缩层
 * （G1/estimateTokens）按需算——切块不重复估算。
 *
 * 返回 [] 当且仅当输入为空字符串（调用方应保证前面已判过 `text !== ''`）。
 * 长度 ≤ budget 的输入原样单卷返回（带前缀）；超过的按 budget 硬切。
 */
export const splitChunk = (text: string, chunkTokens = DEFAULT_CHUNK_TOKENS): string[] => {
  if (text.length === 0) return []

  // 有效期预算：前缀本身占用字符数。故每卷实际正文 ≤ budget - 前缀长。
  const budget = Math.max(chunkTokens, 2)

  // 用**最坏前缀长度**算切割容量，保证任意实际前缀（≤ 最坏）都让每卷不超过 budget：
  //   - 最坏总卷数 maxTotal = text.length（极端：每卷 1 字符 → 卷数 = 字符数）
  //   - 最坏前缀 = 卷号与总数都取 maxTotal 的位数（如「（资料分卷 999999/999999）」）
  const maxTotal = text.length
  const maxDigits = String(maxTotal).length
  const maxPrefixLen = chunkPrefix(10 ** maxDigits - 1, 10 ** maxDigits - 1).length
  const bodyCap = Math.max(1, budget - maxPrefixLen)

  // Pass 1：按最坏前缀切原始正文（不嵌前缀——前缀分母要等真实块数定了才有）。
  const bodies: string[] = []
  let rest = text
  while (rest.length > 0) {
    let piece = rest.length <= bodyCap ? rest : rest.slice(0, bodyCap)
    rest = rest.slice(piece.length)
    // surrogate 边界保护：piece 结尾停在孤立高代理（切断了码点对）时回退 1 个
    // 码元，让高代理归入下一卷——避免把一个 emoji 劈成两半（下一卷以低代理开头）。
    const lastCode = piece.charCodeAt(piece.length - 1)
    if (rest.length > 0 && lastCode >= 0xd800 && lastCode <= 0xdbff) {
      piece = piece.slice(0, -1)
      rest = `${String.fromCharCode(lastCode)}${rest}`
    }
    bodies.push(piece)
  }

  // Pass 2：真实块数已知，统一嵌「（资料分卷 n/N）」。每个前缀 ≤ maxPrefixLen，
  // 故 piece + 前缀 ≤ budget 的约束始终成立。
  return bodies.map((body, i) => `${chunkPrefix(i + 1, bodies.length)}\n${body}`)
}