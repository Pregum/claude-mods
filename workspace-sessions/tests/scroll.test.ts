import { expect, test } from 'claude-code/testing'

import { halfPageOffset, isPageMove } from '../hooks/scroll'

// 20 行の窓で 100 行の木。最後に見せられる先頭は 80 行目
const page = (from: number, by: number) => ({
  offset: Math.min(80, Math.max(0, from + by)),
  by,
  bodyRows: 20,
  contentRows: 100,
  isPerson: true,
})

test('ページ送りキーの移動だけを半ページ送りとして扱う', () => {
  expect(isPageMove(page(0, 20))).toBe(true)
  expect(isPageMove(page(40, -20))).toBe(true)
  expect(isPageMove(page(0, 1))).toBe(false) // 矢印
  expect(isPageMove(page(0, 80))).toBe(false) // End
  expect(isPageMove({ ...page(0, 20), isPerson: false })).toBe(false) // mod 自身の $.ui.scroll
})

test('ctrl+d / ctrl+u (ページ送り) は半ページずつ動き、端で止まる', () => {
  expect(halfPageOffset(page(0, 20), 0)).toBe(10)
  expect(halfPageOffset(page(10, 20), 10)).toBe(20)
  expect(halfPageOffset(page(20, -20), 20)).toBe(10)
  expect(halfPageOffset(page(5, -20), 5)).toBe(0)
  expect(halfPageOffset(page(75, 20), 75)).toBe(80)
  // 起点を覚えていないとき: 端で止められていなければ offset - by から戻せる
  expect(halfPageOffset(page(30, 20), undefined)).toBe(40)
})
