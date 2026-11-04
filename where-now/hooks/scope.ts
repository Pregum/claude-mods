import type { TurnKind, WnTools, WnTurn } from '../types'

/** 下から積む順。重い作業ほど上に来る */
export const STACK: readonly (keyof WnTools)[] = ['read', 'run', 'mcp', 'agent', 'edit']

export const COLORS: Record<TurnKind, number> = {
  edit: 0x3fb950,
  run: 0xe3b341,
  read: 0x58a6ff,
  agent: 0xd2a8ff,
  mcp: 0x39c5cf,
  talk: 0x6e7681,
}

const PANEL = 0x0d1117
/** 背景の罫線 */
const GRID = 0x161c26
const PANEL_TINT = 0x33445f
const GAUGE_REST = 0x30363d
const WHITE = 0xffffff
/** 端末の既定の色 */
const DEFAULT = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const FULL_BLOCK = 0x2588
const RIGHT_LINE = 0x2595

export const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

/** a から b へ t (0〜1) だけ寄せる */
export const mix = (a: number, b: number, t: number): number => {
  const part = (shift: number) => {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    return Math.round(x + (y - x) * t) << shift
  }
  return part(16) | part(8) | part(0)
}

const toCells = (words: Uint32Array): string => {
  const bytes = new Uint8Array(words.buffer) as Uint8Array & { toBase64: () => string }
  return bytes.toBase64()
}

/** 1 列分の素の値。束ねた列は重さも内訳も足す */
type Column = { from: number; to: number; weight: number; tools: WnTools }

export const columnsOf = (turns: readonly WnTurn[], width: number): Column[] => {
  const out: Column[] = []
  for (let x = 0; x < width; x += 1) {
    const from = Math.floor((x * turns.length) / width)
    const to = Math.max(from, Math.floor(((x + 1) * turns.length) / width) - 1)
    const group = turns.slice(from, to + 1)
    const tools = { edit: 0, run: 0, read: 0, agent: 0, mcp: 0 }
    for (const turn of group) {
      for (const key of STACK) tools[key] += turn.tools[key]
    }
    out.push({ from, to, weight: group.reduce((sum, one) => sum + one.weight, 0), tools })
  }
  return out
}

/** 下から何ピクセル目がどの色か。小さい依頼も見えるよう高さは平方根で縮める */
const pixelsOf = (column: Column, max: number, height: number): number[] => {
  const tall = Math.max(1, Math.round(Math.sqrt(column.weight / Math.max(1, max)) * height))
  const total = STACK.reduce((sum, key) => sum + column.tools[key], 0)
  if (total === 0) return Array.from({ length: tall }, () => COLORS.talk)
  const pixels: number[] = []
  let used = 0
  for (const key of STACK) {
    used += column.tools[key]
    const end = Math.round((used / total) * tall)
    while (pixels.length < end) pixels.push(COLORS[key])
  }
  return pixels
}

export type ScopeFrame = {
  turns: readonly WnTurn[]
  at: number
  columns: number
  rows: number
  /** 選んでいる依頼の光り方 (0〜1)。0 は静止 */
  pulse: number
  /** 登場の進み (0〜1)。左から順に立ち上がる */
  reveal: number
}

/** 全体マップ: 幅いっぱいが 1 セッション。▀ で 1 セルを上下 2 ピクセルに使う */
export const scopeCells = ({ turns, at, columns, rows, pulse, reveal }: ScopeFrame): string => {
  const height = rows * 2
  const list = columnsOf(turns, columns)
  const max = Math.max(1, ...list.map(column => column.weight))
  // 1 依頼が 3 マス以上あれば、依頼の境目を 1 マス空ける
  const hasGaps = turns.length > 0 && columns / turns.length >= 3
  const words = new Uint32Array(columns * rows * 3)
  list.forEach((column, x) => {
    const isHere = at >= column.from && at <= column.to
    const isGap = hasGaps && x > 0 && list[x - 1]?.from !== column.from
    const grow = Math.min(1, Math.max(0, reveal * 1.6 - (x / Math.max(1, columns)) * 0.6))
    const eased = 1 - (1 - grow) ** 3
    const full = isGap ? [] : pixelsOf(column, max, height)
    const pixels = full.slice(0, Math.ceil(full.length * eased))
    const tall = pixels.length
    const backAt = (y: number): number => {
      const base = (height - 1 - y) % 2 === 1 && (height - 1 - y) % 4 === 3 ? GRID : PANEL
      return isHere ? mix(base, PANEL_TINT, 0.4 + pulse * 0.6) : base
    }
    const paint = (y: number): number => {
      const up = height - 1 - y
      const color = pixels[up]
      if (color === undefined) return backAt(y)
      // 上端を明るく、根元を沈める
      const depth = tall <= 1 ? 1 : up / (tall - 1)
      const shaded = mix(mix(color, PANEL, 0.5), color, depth)
      if (isHere) return mix(shaded, WHITE, 0.12 + pulse * 0.75)
      return up === tall - 1 ? mix(color, WHITE, 0.45) : shaded
    }
    for (let row = 0; row < rows; row += 1) {
      const at3 = (row * columns + x) * 3
      words[at3] = UPPER_HALF
      words[at3 + 1] = paint(row * 2)
      words[at3 + 2] = paint(row * 2 + 1)
    }
  })
  return toCells(words)
}

/** 色だけで残量が分かるよう、色は位置で決める (緑 → 黄 → 赤) */
const gaugeColorAt = (t: number): number =>
  t < 0.6 ? mix(COLORS.edit, COLORS.run, t / 0.6) : mix(COLORS.run, 0xf85149, (t - 0.6) / 0.4)

/** hasLimit なら右端に compact の走る地点の線を引く */
export const gaugeCells = (percent: number, columns: number, hasLimit = false): string => {
  const words = new Uint32Array(columns * 3)
  const used = (percent / 100) * columns
  for (let x = 0; x < columns; x += 1) {
    const isLimit = hasLimit && x === columns - 1
    words[x * 3] = isLimit ? RIGHT_LINE : LOWER_HALF
    words[x * 3 + 1] = isLimit
      ? gaugeColorAt(1)
      : x < used
        ? gaugeColorAt(x / Math.max(1, columns - 1))
        : GAUGE_REST
    words[x * 3 + 2] = DEFAULT
  }
  return toCells(words)
}

/** 選んでいる行の左の縦線。1 セルだけ blit で光らせる */
export const railCells = (color: number, pulse: number): string =>
  toCells(Uint32Array.of(FULL_BLOCK, mix(mix(color, PANEL, 0.35), WHITE, pulse), DEFAULT))

/** 脈: 消えきらず、はっきり点滅して見える形 (周期 1.2 秒) */
export const pulseAt = (ms: number): number => {
  const wave = (Math.sin((ms / 1200) * Math.PI * 2) + 1) / 2
  return wave * wave
}
