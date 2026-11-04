import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'where-now',
  component: 'Pane',
  requestId: 'where-now',
  props: {
    title: '今どこ',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const host = (on: On, answer: (e: { tool: string }) => unknown = () => ({ result: {} })) => {
  on('session.root', () => ({ value: '/w/repo' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', (_, e) => answer(e) as never)
}

test('ターンの依頼と、読んだ・書いたファイルを出し、次の依頼で消す', async ($, on) => {
  host(on)
  await $.turn.start({ text: 'README を直して', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/w/repo/README.md' })
  await $.tool.call({ tool: 'Read', file_path: '/w/repo/README.md' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/repo/src/a.ts', old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /README を直して/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /README\.md/ }))?.text).toBe('· README.md ×2')
    expect((await ui.find({ type: 'Text', text: /a\.ts/ }))?.text).toBe('✎ src/a.ts')
    expect(await ui.find({ type: 'Text', text: /読 1 · 書 1/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.start({ text: '', turnId: 't2' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ text: 'サブの仕事', turnId: 't3', agentId: 'sub1' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ text: '次の依頼', turnId: 't4' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /まだ触っていません/ })).toBeDefined()
  await ui.unmount()
})

test('失敗した書き込みは書いた数に入れず ✗ で出す', async ($, on) => {
  host(on, () => ({ deny: 'だめ' }))
  await $.tool.call({ tool: 'Write', file_path: '/w/repo/x.ts', content: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /x\.ts/ }))?.text).toBe('✗ x.ts')
  expect(await ui.find({ type: 'Text', text: /読 0 · 書 0/ })).toBeDefined()
  await ui.unmount()
})

test('TodoWrite の計画を進み具合つきで出す', async ($, on) => {
  host(on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '調べる', status: 'completed', activeForm: '調べています' },
      { content: '直す', status: 'in_progress', activeForm: '直しています' },
      { content: '確かめる', status: 'pending', activeForm: '確かめています' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /─ 計画 1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 調べる/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ 直しています/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /○ 確かめる/ })).toBeDefined()
  await ui.unmount()
})

test('TaskCreate と TaskUpdate を追い、deleted は消す', async ($, on) => {
  let n = 0
  host(on, e => {
    if (e.tool === 'TaskCreate') {
      n += 1
      return { result: { task: { id: String(n), subject: 'x' } } }
    }
    return { result: { success: true } }
  })
  await $.tool.call({ tool: 'TaskCreate', subject: '一つ目', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: '二つ目', description: 'd', activeForm: '二つ目を進行中' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /一つ目/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▶ 二つ目を進行中/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /─ 計画 0\/1/ })).toBeDefined()
  await ui.unmount()
})

test('長いパスはファイル名を残して切る', async ($, on) => {
  host(on)
  await $.tool.call({ tool: 'Read', file_path: `/w/repo/${'deep/'.repeat(20)}name.ts` })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /name\.ts/ })
  expect(row?.text.startsWith('· …')).toBe(true)
  await ui.unmount()
})

test('前の版が残した形の違う値は読まない', async ($, on) => {
  on('session.root', () => ({ value: '/w/repo' }))
  on('state.get', (_, e, next) =>
    e.key === 'files' ? { value: { value: [{ path: 1 }], version: 1 } } : next(e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /まだ触っていません/ })).toBeDefined()
  await ui.unmount()
})
