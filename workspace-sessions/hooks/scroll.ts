/** ui.scroll の入力のうち、半ページ送りの計算に使うところ */
export type ScrollMove = {
  /** エンジンが動かそうとしている先 (いまの行 + by、端で止めたもの) */
  offset: number
  /** 頼まれた移動量 (行、上向きが負)。ページ送りキーなら bodyRows */
  by: number
  bodyRows: number
  contentRows: number
  isPerson: boolean
}

/** ページ送りキー (PageDown / PageUp、ctrl+d / ctrl+u を割り当てたもの) の移動か */
export const isPageMove = (move: ScrollMove): boolean =>
  move.isPerson && move.bodyRows > 1 && Math.abs(move.by) === move.bodyRows

/**
 * ページ送りを vim の ctrl+d / ctrl+u と同じ半ページに縮めた先。
 * `from` はいま見せている最初の行 (覚えていなければ offset - by から戻す)
 */
export const halfPageOffset = (move: ScrollMove, from: number | undefined): number => {
  const last = Math.max(0, move.contentRows - move.bodyRows)
  const clamp = (n: number) => Math.min(last, Math.max(0, n))
  const start = clamp(from ?? move.offset - move.by)
  const half = Math.max(1, Math.floor(move.bodyRows / 2))
  return clamp(start + Math.sign(move.by) * half)
}
