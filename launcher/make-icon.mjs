// make-icon.mjs — 生成 H/E 桌面图标（he.ico），纯 Node 零依赖。
//
// 设计（"有些气势"）：近黑圆角方块 + 一条对角蓝色光带（斜杠意象融进背景）+
// 白色 HE 连字。≥48px 画 HE 双字母；更小尺寸只画 H（E 在 16/32px 下不可辨）。
//
// 技术路线：手写像素（矩形笔画 + 圆角 + 线性渐变逐像素插值），打包成
// PNG-in-ICO 不行（无编码器）→ 用 32bpp BMP-in-ICO（Vista+ 全支持）：
// BITMAPINFOHEADER(40) + BGRA 像素（bottom-up）+ 1bpp AND mask。
//
// Run: node launcher/make-icon.mjs   →  launcher/he.ico

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'he.ico')
const SIZES = [256, 64, 48, 32, 16]

// ---- 调色（deepseek 明亮主题的品牌蓝 + 近黑底）----
const BLUE = [79, 110, 247] // #4f6ef7
const BLUE_DIM = [59, 85, 217] // #3b55d9（光带下沿）
const INK = [16, 20, 24] // #101418 近黑底
const WHITE = [255, 255, 255]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t

/**
 * 渲染一帧 size×size 的 RGBA buffer（top-down，最后打包时翻转为 BMP 的 bottom-up）。
 * @param {number} size
 * @param {boolean} withE 双字母（小尺寸 false，只画 H）
 */
function render(size, withE) {
  const buf = new Uint8ClampedArray(size * size * 4)
  const px = (x, y, [r, g, b], a = 255) => {
    const i = (y * size + x) * 4
    // src-over 合成（白色笔画叠在背景/光带上，硬边不透明）
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
  }
  const get = (x, y) => {
    const i = (y * size + x) * 4
    return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
  }

  const r = size * 0.22 // 圆角半径
  const rr = r * r
  const corner = (x, y) => {
    // 四角圆角判定：点到对应圆角圆心的距离
    const cx = x < r ? r : x >= size - r ? size - 1 - r : null
    if (cx === null) return true
    const cy = y < r ? r : y >= size - r ? size - 1 - r : null
    if (cy === null) return true
    const dx = x - cx, dy = y - cy
    return dx * dx + dy * dy <= rr
  }

  // ---- 1. 背景：近黑圆角方块 ----
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (corner(x, y)) px(x, y, INK)
    }
  }
  // ---- 2. 对角蓝色光带（"/" 的意象）：沿 y = -x 方向的宽带，边缘线性羽化 ----
  const band = size * 0.30 // 光带宽度
  const feather = size * 0.06
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!corner(x, y)) continue
      // 距对角线（x + y = size·0.95）的带符号距离
      const d = Math.abs(x + y - size * 0.95) / Math.SQRT2
      if (d < band / 2) {
        // 光带内部：沿带向做渐变（右上亮 → 左下深）
        const t = clamp((x - y + size) / (2 * size), 0, 1)
        px(x, y, [
          lerp(BLUE_DIM[0], BLUE[0], t),
          lerp(BLUE_DIM[1], BLUE[1], t),
          lerp(BLUE_DIM[2], BLUE[2], t),
        ])
      } else if (d < band / 2 + feather) {
        // 羽化边：与底色混合
        const k = 1 - (d - band / 2) / feather
        const base = get(x, y)
        px(x, y, [
          lerp(base[0], BLUE[0], k * 0.55),
          lerp(base[1], BLUE[1], k * 0.55),
          lerp(base[2], BLUE[2], k * 0.55),
        ])
      }
    }
  }

  // ---- 3. 白色笔画（坐标全部为 0–1 比例，rect 内部换算像素并夹紧边界）----
  const W = 0.085 // 笔画宽（比例）
  const rect = (x0, y0, x1, y1) => {
    const X0 = Math.round(clamp(x0, 0, 1) * size)
    const X1 = Math.round(clamp(x1, 0, 1) * size)
    const Y0 = Math.round(clamp(y0, 0, 1) * size)
    const Y1 = Math.round(clamp(y1, 0, 1) * size)
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0; x < X1; x++) {
        px(x, y, WHITE)
      }
    }
  }

  if (withE) {
    // "H"（左）+ "E"（右），整体垂直居中 0.28–0.72
    const hx0 = 0.13, hx1 = 0.44
    const mid = 0.475, midH = 0.055
    rect(hx0, 0.28, hx0 + W, 0.72)               // H 左竖
    rect(hx1 - W, 0.28, hx1, 0.72)               // H 右竖
    rect(hx0, mid, hx1, mid + midH)              // H 中横
    // 斜杠点缀（H E 之间，窄）
    const sw = 0.045 * size
    const slash = (t) => {
      // 从下 (0.485,0.74) 到上 (0.515,0.26) 的斜线，按 t 插值画点
      const cx = lerp(0.475, 0.525, t) * size
      const cy = lerp(0.74, 0.26, t) * size
      for (let dy = -sw / 2; dy < sw / 2; dy++) {
        for (let dx = -sw / 2; dx < sw / 2; dx++) {
          const x = Math.round(cx + dx), y = Math.round(cy + dy)
          if (x >= 0 && x < size && y >= 0 && y < size) px(x, y, WHITE)
        }
      }
    }
    for (let t = 0; t <= 1; t += 0.5 / size) slash(t)
    // "E"
    const ex = 0.56, exEnd = 0.87
    rect(ex, 0.28, ex + W, 0.72)                 // E 竖
    rect(ex, 0.28, exEnd, 0.28 + W)              // E 上横
    rect(ex, mid, exEnd - 0.03, mid + midH)      // E 中横（略短，视觉平衡）
    rect(ex, 0.72 - W, exEnd, 0.72)              // E 下横
  } else {
    // 小尺寸：只画粗 H，笔画加粗保证 16px 可辨
    const w = size * 0.13
    rect(0.24, 0.22, 0.24 + w, 0.78)
    rect(0.63 - w, 0.22, 0.63, 0.78)
    rect(0.24, 0.455, 0.63, 0.545)
  }
  return buf
}

// ---- BMP-in-ICO 打包 ----
function bmpEntry(size, rgba) {
  const rowBytes = size * 4
  const xor = Buffer.alloc(rowBytes * size)
  // bottom-up：最后一行是图像第一行
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y
    for (let x = 0; x < size; x++) {
      const si = (srcRow * size + x) * 4
      const di = y * rowBytes + x * 4
      xor[di] = rgba[si + 2] // B
      xor[di + 1] = rgba[si + 1] // G
      xor[di + 2] = rgba[si] // R
      xor[di + 3] = rgba[si + 3] // A
    }
  }
  // AND mask：1bpp，每行 4 字节对齐，全 0（不透明，alpha 由 32bpp 通道负责）
  const maskRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(maskRow * size)

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // 双高度（XOR+AND）
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(xor.length + and.length, 20)

  return Buffer.concat([header, xor, and])
}

function buildIco() {
  const images = SIZES.map((s) => ({ size: s, rgba: render(s, s >= 48) })).map((im) => ({
    size: im.size,
    data: bmpEntry(im.size, im.rgba),
  }))
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + entries.length
  images.forEach((im, i) => {
    const e = i * 16
    entries.writeUInt8(im.size >= 256 ? 0 : im.size, e) // 256 → 0
    entries.writeUInt8(im.size >= 256 ? 0 : im.size, e + 1)
    entries.writeUInt8(0, e + 2) // colors
    entries.writeUInt8(0, e + 3) // reserved
    entries.writeUInt16LE(1, e + 4) // planes
    entries.writeUInt16LE(32, e + 6) // bpp
    entries.writeUInt32LE(im.data.length, e + 8)
    entries.writeUInt32LE(offset, e + 12)
    offset += im.data.length
  })
  return Buffer.concat([head, entries, ...images.map((im) => im.data)])
}

writeFileSync(OUT, buildIco())
console.log(`[make-icon] wrote ${OUT} (${SIZES.join('/')})`)
