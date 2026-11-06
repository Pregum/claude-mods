import { expect, test } from 'claude-code/testing'

import type { SourceFile } from '../types'
import { buildGraph } from './graph'

const file = (group: string, name: string, text: string, kind: SourceFile['kind'] = 'skill'): SourceFile => ({
  kind,
  group,
  name,
  path: `/${group}/${name}`,
  text,
})

const edges = (files: SourceFile[], builtins: string[] = []) =>
  buildGraph(files, new Set(builtins)).links.map(one => `${one.from}>${one.to}`)

test('同じ plugin の中を先に解決し、同名の別 plugin へつながない', () => {
  const files = [
    file('plugin:a', 'guide', '`/guide-a` と `shared-name` を使う'),
    file('plugin:a', 'guide-a', ''),
    file('plugin:a', 'shared-name', ''),
    file('plugin:b', 'shared-name', ''),
    file('project', 'mine', '`shared-name` を呼ぶ'),
  ]
  expect(edges(files)).toEqual(['plugin:a/guide>plugin:a/guide-a', 'plugin:a/guide>plugin:a/shared-name'])
})

test('組み込みのコマンドと普通の単語を参照にしない', () => {
  const files = [
    file('project', 'mine', '/help を見る。pdf に書き出す。README.md の review 手順。https://x.dev/add-tips </pdf>'),
    file('plugin:r', 'help', ''),
    file('plugin:r', 'review', ''),
    file('project', 'pdf', ''),
    file('project', 'add-tips', ''),
  ]
  expect(edges(files, ['help'])).toEqual([])
})

test('一語の名前は /名前・名前空間・「スキル」が付くと参照になる', () => {
  const files = [
    file('project', 'mine', 'pdf スキルで作り /aid を呼び r:review も使う'),
    file('project', 'pdf', ''),
    file('project', 'aid', ''),
    file('plugin:r', 'review', ''),
  ]
  expect(edges(files)).toEqual(['project/mine>project/pdf', 'project/mine>project/aid', 'project/mine>plugin:r/review'])
})

test('スキルとコマンドの同名は 1 つにまとめ、参照は件数に数える', () => {
  const map = buildGraph(
    [
      file('project', 'deck', '`add-tips` と add-tips', 'command'),
      file('project', 'deck', '', 'skill'),
      file('project', 'add-tips', ''),
    ],
    new Set(),
  )
  expect(map.nodes.find(one => one.id === 'project/deck')?.kinds).toEqual(['command', 'skill'])
  expect(map.links).toHaveLength(1)
  expect(map.links[0]?.count).toBe(2)
})

test('ファイルパスだけの参照に印を付け、自分自身へはつながない', () => {
  const map = buildGraph(
    [
      file('project', 'a', 'mine: a-b を見る\nnode .claude/skills/lib-x/run.cjs\n'),
      file('project', 'a-b', 'a-b は自分'),
      file('project', 'lib-x', ''),
      file('project', 'mine', ''),
    ],
    new Set(),
  )
  const toLib = map.links.find(one => one.to === 'project/lib-x')
  expect(toLib?.isPathOnly).toBe(true)
  expect(toLib?.line).toBe(2)
  expect(map.links.some(one => one.from === one.to)).toBe(false)
})

test('サブフォルダのコマンドを /フォルダ:名前 で解決する', () => {
  const files = [
    file('project', 'mine', '/user:fix-pr を呼ぶ'),
    file('user', 'user:fix-pr', '', 'command'),
  ]
  expect(edges(files)).toEqual(['project/mine>user/user:fix-pr'])
})

test('説明は折り返した frontmatter も読み、無ければ本文の見出しを使う', () => {
  const map = buildGraph(
    [
      file('project', 'a', '---\nname: a\ndescription: >\n  一行目\n  二行目\nmodel: x\n---\n本文'),
      file('project', 'b', '---\ndescription: "引用つき"\n---\n'),
      file('project', 'c', '# 見出し\n本文'),
    ],
    new Set(),
  )
  expect(map.nodes.map(one => one.description.replace(/\s+/g, ' '))).toEqual(['一行目 二行目', '引用つき', '見出し'])
})
