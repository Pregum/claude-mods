import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pane-todo',
  component: 'Pane',
  requestId: 'pane-todo',
  props: {
    title: 'Todo',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = new Date(2026, 10, 4, 12, 0).getTime()

const FAKE = [
  { id: 'local/a', title: '請求書を送る', source: 'local', notes: '先方の窓口へ', url: 'https://example.com/a' },
  { id: 'local/b', title: '期限切れの用事', source: 'local', due: '2026-10-20T00:00:00.000' },
  { id: 'local/c', title: '三つ目', source: 'local' },
]

type Call = { tool: string; args: Record<string, unknown> | undefined }

const host = (on: On, { fail = false } = {}) => {
  const seen = {
    calls: [] as Call[],
    fills: [] as string[],
    sent: [] as string[],
    toasts: [] as string[],
    closed: 0,
    tasks: [...FAKE],
    /** 期限が無いので「今日」に出ない Todo */
    undated: [] as typeof FAKE,
  }
  on('clock.now', () => ({ value: NOW }))
  on('mcp.call', (_, e) => {
    seen.calls.push({ tool: e.tool, args: e.args })
    if (fail) return { value: { content: [{ type: 'text', text: 'つながりません' }], isError: true } } as never
    if (e.tool === 'add_task') {
      const added = { id: 'local/new', title: String(e.args?.title), source: 'local' }
      seen.undated.push(added)
      return { value: { content: [{ type: 'text', text: JSON.stringify(added) }], isError: false } } as never
    }
    if (e.tool === 'list_tasks' && e.args?.tab === 'active') {
      const text = JSON.stringify({ count: 0, tasks: [...seen.tasks, ...seen.undated] })
      return { value: { content: [{ type: 'text', text }], isError: false } } as never
    }
    if (e.tool === 'complete_task' && e.args?.completed !== false) {
      seen.tasks = seen.tasks.filter(todo => todo.id !== e.args?.id)
    }
    const text = JSON.stringify({ count: seen.tasks.length, tasks: seen.tasks })
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.close', () => {
    seen.closed += 1
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    seen.sent.push(e.text)
    return { text: e.text } as never
  })
  on('prompt.fill', (_, e) => {
    seen.fills.push(e.text)
    return { isFilled: true } as never
  })
  return seen
}

const mountLoaded = async ($: never, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal') => {
  const engine = $ as { ui: { mount: (x: unknown) => Promise<never> } }
  const ui = (await engine.ui.mount({ ...PANE, surface })) as {
    press: (x: { key: string }) => Promise<void>
    input: (x: { key: string; text: string }) => Promise<void>
    find: (x: unknown) => Promise<{ text: string; props: Record<string, unknown> } | undefined>
    unmount: () => Promise<void>
  }
  await ui.press({ key: 'refresh' })
  for (let i = 0; i < 40 && !(await ui.find({ type: 'Text', text: /請求書|はありません|つながりません/ })); i += 1) {
    await ui.find({ type: 'Text' })
  }
  return ui
}

const settle = async (ui: { find: (x: unknown) => Promise<unknown> }) => {
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
}

test('Todo を並べ、期限切れを数え、全部の画面で描ける', async ($, on) => {
  host(on)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await mountLoaded($ as never, surface)
    expect(await ui.find({ type: 'Text', text: /請求書を送る/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /期限切れ 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 10\/20$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('x は選んでいる Todo だけを完了にし、次へ移り、u で戻す', async ($, on) => {
  const seen = host(on)
  const ui = await mountLoaded($ as never)
  await ui.press({ key: 'done' })
  await settle(ui)
  expect(seen.calls.find(call => call.tool === 'complete_task')?.args).toEqual({ id: 'local/a' })
  expect(await ui.find({ type: 'Text', text: /請求書を送る/ })).toBeUndefined()
  expect(seen.toasts.at(-1)).toMatch(/完了: 請求書を送る/)
  await ui.press({ key: 'undo' })
  await settle(ui)
  expect(seen.calls.filter(call => call.tool === 'complete_task').at(-1)?.args).toEqual({
    id: 'local/a',
    completed: false,
  })
  await ui.unmount()
})

test('行の Enter は下書きに入れて閉じる。送りはしない', async ($, on) => {
  const seen = host(on)
  const ui = await mountLoaded($ as never)
  await ui.press({ key: 'task:local/a' })
  await settle(ui)
  expect(seen.fills).toEqual(['Todo: 請求書を送る\n\n先方の窓口へ'])
  expect(seen.closed).toBe(1)
  await ui.unmount()
})

test('期限の無い Todo を足すと「すべて」へ移り、足したものを選ぶ', async ($, on) => {
  const seen = host(on)
  const ui = await mountLoaded($ as never)
  await ui.press({ key: 'add' })
  await settle(ui)
  await ui.input({ key: 'new-todo', text: 'test' })
  await settle(ui)
  expect(seen.calls.find(call => call.tool === 'add_task')?.args).toEqual({ title: 'test' })
  expect(seen.calls.at(-1)?.args).toEqual({ tab: 'active', limit: 100 })
  expect(await ui.find({ type: 'Text', text: /^test/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^› $/ })).toBeDefined()
  expect(seen.toasts.at(-1)).toMatch(/「すべて」に出ています/)
  await ui.unmount()
})

test('s は 2 回押すと送り、1 回では送らない。送っても完了にはしない', async ($, on) => {
  const seen = host(on)
  const ui = await mountLoaded($ as never)
  await ui.press({ key: 'send' })
  await settle(ui)
  expect(seen.sent).toEqual([])
  expect(seen.toasts.at(-1)).toMatch(/もう一度 s/)
  await ui.press({ key: 'send' })
  await settle(ui)
  expect(seen.sent).toEqual(['Todo: 請求書を送る\n\n先方の窓口へ'])
  expect(seen.closed).toBe(1)
  expect(seen.calls.some(call => call.tool === 'complete_task')).toBe(false)
  await ui.unmount()
})

test('s のあと別の Todo へ移ると、もう一度数え直す', async ($, on) => {
  const seen = host(on)
  const ui = await mountLoaded($ as never)
  await ui.press({ key: 'send' })
  await ui.press({ key: 'next' })
  await settle(ui)
  await ui.press({ key: 'send' })
  await settle(ui)
  expect(seen.sent).toEqual([])
  await ui.unmount()
})

test('タブを変えると、その面を読む', async ($, on) => {
  const seen = host(on)
  const ui = await mountLoaded($ as never)
  await ui.press({ key: 'tab:focus' })
  await settle(ui)
  expect(seen.calls.at(-1)).toEqual({ tool: 'list_tasks', args: { tab: 'focus', limit: 100 } })
  await ui.unmount()
})

test('Pane につながらないときは理由を出す', async ($, on) => {
  host(on, { fail: true })
  const ui = await mountLoaded($ as never)
  expect(await ui.find({ type: 'Text', text: /つながりません/ })).toBeDefined()
  await ui.unmount()
})

test('前の版が残した形の違う値は読まない', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e, next) =>
    e.key === 'list' ? { value: { value: { tasks: 'broken' }, version: 1 } } : next(e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /読み込み中/ })).toBeDefined()
  await ui.unmount()
})
