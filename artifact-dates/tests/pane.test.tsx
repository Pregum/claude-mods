import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'artifact-dates',
  component: 'Pane',
  requestId: 'artifact-dates',
  props: {
    title: 'Artifacts',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = new Date(2026, 10, 4, 12, 0).getTime()

const MINE = `2 published artifacts:
- (mine) 古いもの — https://claude.ai/artifact/old — updated 2026-09-25
- (mine, pinned) 新しいもの — https://claude.ai/artifact/new — updated 2026-11-04
`
const SHARED = '- (shared) もらったもの — https://claude.ai/artifact/got\n'

const host = (on: On, { fail = false } = {}) => {
  const seen = { timers: [] as (() => void)[], reads: [] as string[], fills: [] as string[], closed: 0, lists: [] as unknown[], opened: [] as string[][], copied: [] as string[], toasts: [] as string[] }
  on('clock.now', () => ({ value: NOW }))
  // 待ちを手で進める。flush までタイマーは発火しない
  on('clock.after', () => new Promise(done => seen.timers.push(() => done({ value: undefined } as never))))
  on('tool.call', { tool: 'Artifact' }, (_, e) => {
    if ((e as { action?: string }).action === 'read') {
      seen.reads.push(String((e as { url?: string }).url))
      const text = '<html><body><h1>本文の見出し</h1><p>本文の文章</p></body></html>'
      return { result: {}, text, isError: false } as never
    }
    seen.lists.push(e)
    if (fail) return { deny: '許可されませんでした' } as never
    const text = (e as { scope?: string }).scope === 'shared' ? SHARED : MINE
    return { result: {}, text, isError: false } as never
  })
  on('process.run', (_, e) => {
    seen.opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)
    return { isCopied: true } as never
  })
  on('ui.focus', () => ({}))
  on('ui.close', () => {
    seen.closed += 1
    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    seen.fills.push(e.text)
    return { isFilled: true } as never
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

/** 溜まったタイマーを全部発火して、走り終えるのを待つ */
const flush = async (seen: { timers: (() => void)[] }, ui: Ui) => {
  for (const fire of seen.timers.splice(0)) fire()
  for (let i = 0; i < 60; i += 1) await ui.find({ type: 'Text' })
}

type Ui = {
  press: (x: { key: string }) => Promise<void>
  find: (x: unknown) => Promise<{ text: string } | undefined>
  unmount: () => Promise<void>
}

const mounted = async ($: unknown, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal') => {
  const engine = $ as { ui: { mount: (x: unknown) => Promise<Ui> } }
  const ui = await engine.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'refresh' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  return ui
}

test('日付の新しい順に見出しつきで描き、全部の画面で動く', async ($, on) => {
  host(on)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await mounted($, surface)
    expect(await ui.find({ type: 'Text', text: /^今日/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2026年9月/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /新しいもの/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^★ $/ })).toBeDefined()
    await ui.unmount()
  }
})

test('行の Enter はブラウザで開き、ペインは残す', async ($, on) => {
  const seen = host(on)
  const ui = await mounted($)
  await ui.press({ key: 'art:https://claude.ai/artifact/old' })
  expect(seen.opened).toEqual([['open', 'https://claude.ai/artifact/old']])
  expect(await ui.find({ type: 'Text', text: /古いもの/ })).toBeDefined()
  await ui.unmount()
})

test('共有へ切り替えると読み直し、日付なしにまとめる', async ($, on) => {
  const seen = host(on)
  const ui = await mounted($)
  await ui.press({ key: 'scope:shared' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  expect(await ui.find({ type: 'Text', text: /もらったもの/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^日付なし/ })).toBeDefined()
  expect(seen.lists.length).toBeGreaterThan(1)
  await ui.unmount()
})

test('動いている間は読まず、止まった行の本文だけを読む', async ($, on) => {
  const seen = host(on)
  const ui = await mounted($)
  seen.timers.splice(0)
  await ui.press({ key: 'next' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  await ui.press({ key: 'prev' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  expect(seen.reads).toEqual([])
  await flush(seen, ui)
  expect(seen.reads).toEqual(['https://claude.ai/artifact/new'])
  expect(await ui.find({ type: 'Text', text: /本文の見出し/ })).toBeDefined()
  await ui.press({ key: 'next' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  await ui.press({ key: 'prev' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  await flush(seen, ui)
  expect(seen.reads.length).toBe(1)
  await ui.unmount()
})

test('共有の本文は読まない', async ($, on) => {
  const seen = host(on)
  const ui = await mounted($)
  await ui.press({ key: 'scope:shared' })
  for (let i = 0; i < 60; i += 1) await ui.find({ type: 'Text' })
  await flush(seen, ui)
  expect(await ui.find({ type: 'Text', text: /もらったもの/ })).toBeDefined()
  expect(seen.reads).toEqual([])
  expect(await ui.find({ type: 'Text', text: /本文は読みません/ })).toBeDefined()
  await ui.unmount()
})

test('続きを頼むと下書きに入れて閉じる。送りはしない', async ($, on) => {
  const seen = host(on)
  const ui = await mounted($)
  await ui.press({ key: 'ask' })
  for (let i = 0; i < 40; i += 1) await ui.find({ type: 'Text' })
  expect(seen.fills).toEqual(['Artifact「新しいもの」の続きをお願いします。\nhttps://claude.ai/artifact/new\n'])
  expect(seen.closed).toBe(1)
  await ui.unmount()
})

test('読めないときは理由を出す', async ($, on) => {
  host(on, { fail: true })
  const ui = await mounted($)
  expect(await ui.find({ type: 'Text', text: /許可されませんでした/ })).toBeDefined()
  await ui.unmount()
})

test('前の版が残した形の違う値は読まない', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e, next) =>
    e.key === 'lists' ? { value: { value: { mine: 'broken' }, version: 1 } } : next(e),
  )
  const engine = $ as unknown as { ui: { mount: (x: unknown) => Promise<Ui> } }
  const ui = await engine.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /読み込み中/ })).toBeDefined()
  await ui.unmount()
})
