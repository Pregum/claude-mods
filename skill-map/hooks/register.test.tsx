import { expect, test } from 'claude-code/testing'

import type { SkillGraph } from '../types'
import { focusBlock, homeRows, overviewBlocks, pickerRows, pickRow } from './register'

const node = (group: string, name: string) => ({
  id: `${group}/${name}`,
  name,
  group,
  kinds: ['skill'],
  paths: [`/${name}.md`],
  description: '',
  isEditable: group === 'project',
})

const link = (from: string, to: string) => ({
  from,
  to,
  path: '/x.md',
  count: 1,
  line: 3,
  excerpt: '手順',
  isPathOnly: false,
})

const map: SkillGraph = {
  nodes: [node('project', 'a'), node('project', 'b'), node('project', 'c'), node('plugin:p', 'd')],
  links: [
    link('project/a', 'project/b'),
    link('project/b', 'project/a'),
    link('project/a', 'project/c'),
    link('project/c', 'plugin:p/d'),
  ],
}

test('一覧はグループごとに畳み、plugin の状態を見せる', () => {
  const rows = homeRows(map, [{ group: 'plugin:p', isEnabled: true, hasHooks: true, hasMcp: false }], ['project'], '')
  expect(rows.map(one => one.text)).toEqual(['▾ このプロジェクト', 'a', 'b', 'c', '▸ p'])
  expect(rows[4]?.kind === 'group' && rows[4].note).toContain('hook')
})

const text = (lines: { text: string }[][]) => lines.map(line => line.map(one => one.text).join(''))

test('中心のスキルから呼ぶ先までを矢印で描き、相互参照は ◀▶ にする', () => {
  const { drawing } = focusBlock(map, 'project/a')
  const lines = text(drawing.lines)
  expect(drawing.nodeIds.sort()).toEqual(['plugin:p/d', 'project/a', 'project/b', 'project/c'])
  expect(lines.join('\n')).toContain('◀▶[b]')
  expect(lines.join('\n')).toContain('─▶[c]')
  expect(lines.join('\n')).toContain('─▶[d]')
})

test('全体図はつながる塊ごとに分け、孤立したスキルは数える', () => {
  const solo: SkillGraph = { ...map, nodes: [...map.nodes, node('project', 'lonely')] }
  const { blocks, isolated } = overviewBlocks(solo, ['project'])
  expect(blocks).toHaveLength(1)
  expect(isolated).toBe(1)
})

test('絞り込みと選択先の候補に自分を出さない', () => {
  expect(homeRows(map, [], [], 'd').map(one => one.text)).toEqual(['d'])
  expect(pickerRows(map, 'project/a', '').map(one => one.text)).toEqual(['b', 'c', 'd'])
})

test('行の移動は端で止まり、位置が不明なら既定の行から数える', () => {
  expect(pickRow(['a', 'b'], 'b', undefined, 1)).toBe('b')
  expect(pickRow(['a', 'b', 'c'], '', 'b', 1)).toBe('c')
  expect(pickRow(['a', 'b'], '', undefined, 1)).toBe('b')
})

const PANE = {
  plugin: 'skill-map',
  component: 'Pane',
  requestId: 'skill-map',
  props: {
    title: 'スキルの地図',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('開くと読み込み、スキルへ移動してつなぐ依頼を下書きする', async ($, on) => {
  const drafts: string[] = []
  on('command.register', () => ({ value: { command: 'skillmap' } }))
  on('command.list', () => ({ value: [{ name: 'help', description: '', source: 'builtin' }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }))
  on('fs.list', (_, e) => ({
    value: e.path === '/repo/.claude/skills'
      ? [
          { name: 'deck-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'deck-b', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        ]
      : [],
  }))
  on('fs.read', (_, e) => ({ value: e.path.includes('deck-a') ? '`deck-b` を呼ぶ' : '' }))
  on('prompt.fill', (_, e) => {
    drafts.push(e.text)
    return { isFilled: true }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'skillmap', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (let turn = 0; turn < 50 && !(await ui.find({ key: 'row:g:project/deck-a' })); turn += 1) {
    await new Promise(done => setTimeout(done, 5))
  }

  await ui.press({ key: 'row:g:project/deck-a' })
  expect(await ui.find({ key: 'row:g:project/deck-b' })).toBeDefined()

  expect((await ui.find({ type: 'Text', text: /つながりの詳細/ }))).toBeDefined()

  // 移動した直後でも、次のノードへ進める
  expect(await ui.find({ type: 'Text', text: /呼ぶ箇所/ })).toBeUndefined()
  await ui.press({ key: 'move-down' })
  expect(await ui.find({ type: 'Text', text: /呼ぶ箇所/ })).toBeDefined()
  await ui.press({ key: 'move-up' })
  expect(await ui.find({ type: 'Text', text: /呼ぶ箇所/ })).toBeUndefined()

  await ui.press({ key: 'row:g:project/deck-a' })
  expect((await ui.find({ type: 'Text', text: /deck-b.+呼ぶ/ }))).toBeDefined()
  await ui.press({ key: 'read-back' })

  await ui.press({ key: 'add' })
  await ui.press({ key: 'row:pick:project/deck-b' })
  expect(drafts).toEqual([
    '/repo/.claude/skills/deck-a/SKILL.md の適切な手順から deck-b を呼ぶようにしてください。どこに入れるかを先に提案し、書き換える前に差分を見せてください。',
  ])
  await ui.unmount()
})
