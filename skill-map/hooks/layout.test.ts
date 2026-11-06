import { expect, test } from 'claude-code/testing'

import { components, drawGraph, pickSide, sliceLine, treeEdges, wrapLines } from './layout'

const same = (id: string) => id
const lines = (drawing: ReturnType<typeof drawGraph>) =>
  drawing.lines.map(line => line.map(one => one.text).join(''))

test('左から右へ段に並べ、分岐を罫線でつなぐ', () => {
  const drawing = drawGraph(
    ['a', 'b', 'c'],
    [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }],
    same,
  )
  const text = lines(drawing).join('\n')
  expect(text).toContain('[a]')
  expect(text).toContain('▶[b]')
  expect(text).toContain('▶[c]')
  expect(text).toMatch(/[┬├┌└]/)
})

test('循環でも止まり、戻る線は逆向きの矢印にする', () => {
  const drawing = drawGraph(
    ['a', 'b', 'c'],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
    same,
  )
  expect(drawing.nodeIds).toHaveLength(3)
  expect(lines(drawing).join('\n')).toContain('◀')
})

test('2 段以上またぐ線も途切れない', () => {
  const drawing = drawGraph(
    ['a', 'b', 'c'],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }],
    same,
  )
  expect(lines(drawing).join('\n')).not.toContain('[c]─')
  expect(drawing.nodeIds).toHaveLength(3)
})

test('長い図は全部描き、窓の分だけ切り出せる', () => {
  const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd']
  const edges = ids.slice(1).map((to, index) => ({ from: ids[index] ?? '', to }))
  const drawing = drawGraph(ids, edges, same)
  expect(drawing.width).toBeGreaterThan(40)

  const last = drawing.places.at(-1)
  const line = drawing.lines[0] ?? []
  const shown = sliceLine(line, (last?.x ?? 0) - 2, 40)
  expect(shown.map(one => one.text).join('')).toContain('[dddddddddddddddd]')
  expect(shown.find(one => one.nodeId)?.nodeId).toBe(ids[3])
  expect(sliceLine(line, 0, 40).some(one => one.nodeId === ids[3])).toBe(false)
})

test('塊に分け、木は深さで止める', () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }]
  expect(components(['a', 'b', 'c', 'x'], edges).map(one => one.length)).toEqual([3, 1])
  expect(treeEdges(['a'], edges, 1)).toEqual([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }])
})

test('左右の移動は隣の段で一番近いノードへ行き、端では動かない', () => {
  const places = [
    { id: 'a', layer: 0, row: 3, x: 0, width: 3 },
    { id: 'b', layer: 1, row: 0, x: 9, width: 3 },
    { id: 'c', layer: 1, row: 2, x: 9, width: 3 },
  ]
  expect(pickSide(places, 'a', 1)).toBe('c')
  expect(pickSide(places, 'c', -1)).toBe('a')
  expect(pickSide(places, 'a', -1)).toBeUndefined()
})

test('説明はいつも同じ行数にする', () => {
  expect(wrapLines('短い', 10, 3)).toEqual(['短い', '', ''])
  const long = wrapLines('あ'.repeat(40), 10, 2)
  expect(long).toHaveLength(2)
  expect(long[1]?.endsWith('…')).toBe(true)
})
