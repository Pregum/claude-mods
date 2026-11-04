import { expect, test } from 'claude-code/testing'

import type { WnTurn } from '../types'
import { columnsOf, gaugeCells, mix, pulseAt, railCells, scopeCells } from '../hooks/scope'
import { shellKind } from '../hooks/shell'

const turn = (edit: number, read: number): WnTurn => ({
  text: 't',
  kind: edit > 0 ? 'edit' : 'read',
  weight: 1 + edit + read,
  tools: { edit, run: 0, read, agent: 0 },
})

const words = (cells: string) => {
  const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  return new Uint32Array(bytes.buffer)
}

const frame = { turns: [turn(1, 1), turn(0, 3)], at: 0, columns: 12, rows: 4, pulse: 0, reveal: 1 }

test('幅いっぱいが 1 セッション: 依頼は幅に均等に広がり、幅を超えると束ねる', () => {
  expect(columnsOf(frame.turns, 12).map(c => c.from)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])
  const many = Array.from({ length: 40 }, () => turn(0, 1))
  const packed = columnsOf(many, 10)
  expect(packed).toHaveLength(10)
  expect(packed[0]?.weight).toBe(8)
  expect(packed.at(-1)?.to).toBe(39)
})

test('セルは列 × 行 × 3 語で、脈の強さで選んだ列だけ変わる', () => {
  const still = words(scopeCells(frame))
  expect(still).toHaveLength(12 * 4 * 3)
  const lit = words(scopeCells({ ...frame, pulse: 1 }))
  const changedAt = new Set<number>()
  for (let i = 0; i < still.length; i += 1) {
    if (still[i] !== lit[i]) changedAt.add(Math.floor(i / 3) % 12)
  }
  expect([...changedAt].every(x => x < 6)).toBe(true)
  expect(changedAt.size).toBeGreaterThan(0)
})

test('登場は左から: 途中では右端の列がまだ立っていない', () => {
  const start = words(scopeCells({ ...frame, reveal: 0.2 }))
  const done = words(scopeCells(frame))
  const bottomRight = (11 + 12 * 3) * 3 + 1
  expect(start[bottomRight]).not.toBe(done[bottomRight])
  expect(words(scopeCells({ ...frame, reveal: 1 }))).toEqual(done)
})

test('ゲージは使った分だけ色がつき、残りは同じ灰色', () => {
  const cells = words(gaugeCells(50, 10))
  expect(cells[1]).not.toBe(cells[4 * 3 + 1])
  expect(cells[5 * 3 + 1]).toBe(cells[9 * 3 + 1])
})

test('compact の地点があるときは右端に線を引く', () => {
  const cells = words(gaugeCells(10, 10, true))
  expect(cells[9 * 3]).toBe(0x2595)
  expect(words(gaugeCells(10, 10))[9 * 3]).toBe(0x2584)
})

test('脈は 0〜1 を行き来し、色の混ぜ方は端で元の色になる', () => {
  expect(pulseAt(300) > 0.99).toBe(true)
  expect(pulseAt(900) < 0.01).toBe(true)
  expect(mix(0x112233, 0xffffff, 0)).toBe(0x112233)
  expect(mix(0x112233, 0xffffff, 1)).toBe(0xffffff)
  expect(words(railCells(0xff0000, 1))[1]).toBe(0xffffff)
})

test('Bash はコマンドの中身で分ける', () => {
  expect(shellKind('cat a.md | head -3')).toBe('read')
  expect(shellKind('cd x && git log --oneline; ls')).toBe('read')
  expect(shellKind('grep foo a 2>/dev/null')).toBe('read')
  expect(shellKind("sed -i '' s/a/b/ f")).toBe('edit')
  expect(shellKind('echo hi > out.txt')).toBe('edit')
  expect(shellKind('rm -rf build')).toBe('edit')
  expect(shellKind('git push origin main')).toBe('run')
  expect(shellKind('claude plugin test .')).toBe('run')
  expect(shellKind('./deploy.sh')).toBe('run')
})
