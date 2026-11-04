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

const withStore = (on: On) => {
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    kept.delete(e.key)
    return { value: undefined }
  })
}

const NO_USAGE = { startedAt: 0, context: { window: 1 }, rateLimits: [] }

const host = (
  on: On,
  answer: (e: { tool: string }) => unknown = () => ({ result: {} }),
  { now = 0, messages = [] as unknown[], usage = NO_USAGE as unknown, transcript = undefined as string | undefined } = {},
) => {
  withStore(on)
  on('session.root', () => ({ value: '/w/repo' }))
  on('clock.now', () => ({ value: now }))
  on('session.messages', () => ({ value: messages as never }))
  on('session.usage', () => ({ value: usage as never }))
  on('env.get', () => ({ value: '/h' }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/w/repo' }))
  on('process.run', () => ({
    value: { exitCode: transcript === undefined ? 1 : 0, stdout: transcript ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.complete', () => ({}) as never)
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
  expect(await ui.find({ type: 'Text', text: /─ 計画 ▰▱▱ 1\/3/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /─ 計画 ▱ 0\/1/ })).toBeDefined()
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
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e, next) =>
    e.key === 'files' ? { value: { value: [{ path: 1 }], version: 1 } } : next(e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /まだ触っていません/ })).toBeDefined()
  await ui.unmount()
})

const pane = (isPlaced: boolean) => ({ id: 'where-now', title: '今どこ', isShown: isPlaced, isFocused: false, isPlaced })

test('/where は開いてキーを渡し、開いていてもキーを渡し、キーがあれば閉じる。閉じたら次の開始では開かない', async ($, on) => {
  let state = { shown: false, focused: false }
  const opens: (true | undefined)[] = []
  let closes = 0
  withStore(on)
  on('session.root', () => ({ value: '/w/repo' }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('command.register', () => ({ value: { command: 'where' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: NO_USAGE as never }))
  on('ui.panes', () => ({
    value: state.shown ? [{ ...pane(true), isFocused: state.focused }] : [],
  }))
  on('ui.open', (_, e) => {
    state = { shown: true, focused: e.focus === true }
    opens.push(e.focus)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    state = { shown: false, focused: false }
    closes += 1
    return { value: undefined }
  })
  const where = () =>
    $.command.run({ command: 'where', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // セッションの開始で開くペインは、プロンプトからキーを奪わない
  await start()
  expect(opens).toEqual([undefined])
  // 開いているがキーが無い: 閉じずにキーを渡す
  await where()
  expect(opens).toEqual([undefined, true])
  expect(closes).toBe(0)
  // キーがあれば閉じる
  await where()
  expect(closes).toBe(1)
  await start()
  expect(opens).toHaveLength(2)
  await where()
  expect(opens).toEqual([undefined, true, true])
  await start()
  expect(opens).toHaveLength(4)
})

test('q で閉じる', async ($, on) => {
  const closed: string[] = []
  host(on)
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  expect(closed).toEqual(['where-now'])
  await ui.unmount()
})

test('ミニマップは人の依頼ごとの重さとセッションの長さを出し、差し込まれた文は数えない', async ($, on) => {
  host(on, undefined, {
    now: 90 * 60_000,
    usage: { startedAt: 0, context: { window: 100, tokens: 43, percent: 43 }, rateLimits: [] },
    messages: [
      { role: 'user', text: '一つ目', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Edit' }, { tool: 'Bash' }, { tool: 'Read' }, { tool: 'Read' }, { tool: 'Read' }, { tool: 'Read' }, { tool: 'Read' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{}] },
      { role: 'user', text: '<system-reminder>x</system-reminder>', toolUses: [] },
      { role: 'assistant', text: '済み', toolUses: [] },
      { role: 'user', text: '二つ目', toolUses: [] },
      { role: 'assistant', text: '済み', toolUses: [] },
    ],
  })
  await $.turn.start({ text: '二つ目', turnId: 't' })

  // 端末: 全体マップとゲージは Raster
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Raster', key: 'scope' })).toBeDefined()
  expect(await term.find({ type: 'Raster', key: 'gauge' })).toBeDefined()
  expect(await term.find({ type: 'Raster', key: 'rail' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^1時間30分$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^#2\/2$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /■ 編集 1/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /■ 調査 5/ })).toBeDefined()
  await term.press({ key: 'prev' })
  expect(await term.find({ type: 'Text', text: /^#1\/2$/ })).toBeDefined()
  await term.press({ key: 'next' })
  await term.unmount()

  // Raster の無い画面は 1 行の帯と、› の印
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  const bar = await ui.find({ type: 'Text', text: /^█$/ })
  expect(bar?.props.color).toBe('#3fb950')
  expect(await ui.find({ type: 'Text', text: /文脈 █{13}░{18} 43%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^›2 $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 1 $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ +7$/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /^›1 $/ })).toBeDefined()
  await ui.unmount()
})

const JUMP_MESSAGES = [
  { role: 'user', text: '調べて', toolUses: [] },
  { role: 'assistant', text: '済み', toolUses: [{ tool: 'Grep' }] },
  { role: 'user', text: '直して', toolUses: [] },
]

const human = (uuid: string, content: unknown) =>
  JSON.stringify({ type: 'user', uuid, origin: { kind: 'human' }, message: { content } })

test('トランスクリプトの uuid か、描かれた行の id で依頼へ飛ぶ。どちらも無ければ知らせる', async ($, on) => {
  const toasts: string[] = []
  host(on, undefined, {
    messages: JUMP_MESSAGES,
    // 1 件目は uuid で引ける。2 件目は文が違い、id なしのまま
    transcript: [human('u1', [{ type: 'text', text: '調べて' }]), human('u2', '別の文')].join('\n'),
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.turn.start({ text: '直して', turnId: 't' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'jump' })
  expect(toasts.at(-1)).toMatch(/場所が分かりませんでした/)
  // テストの engine には会話の行が無いので、id が引けて scroll まで届いたことを見る
  await ui.press({ key: 'turn:0' })
  // scroll の答えは press のあとで届く
  for (let i = 0; i < 20 && !/飛べませんでした/.test(toasts.at(-1) ?? ''); i += 1) await ui.find({ type: 'Text' })
  expect(toasts.at(-1)).toMatch(/飛べませんでした/)
  await ui.unmount()
})

test('巻き戻すと今から分岐は本体のコマンドへ渡す', async ($, on) => {
  const ran: string[] = []
  host(on, undefined, { messages: JUMP_MESSAGES })
  on('command.run', (_, e) => {
    ran.push(e.command)
    return {}
  })
  await $.turn.start({ text: '直して', turnId: 't' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rewind' })
  await ui.press({ key: 'branch' })
  expect(ran).toEqual(['rewind', 'branch'])
  await ui.unmount()
})
