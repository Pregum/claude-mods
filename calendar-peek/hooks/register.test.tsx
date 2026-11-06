import { expect, test } from 'claude-code/testing'

import { pickRow } from './register'

const PANE = {
  plugin: 'calendar-peek',
  component: 'Pane',
  requestId: 'calendar-peek',
  props: {
    title: '予定',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const offset = '+09:00'
const body = {
  events: [
    { id: 'a', summary: '終日の締切', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } },
    { id: 'b', summary: '辞退した会議', start: { dateTime: `2026-11-05T16:00:00${offset}` }, end: { dateTime: `2026-11-05T17:00:00${offset}` }, attendees: [{ self: true, responseStatus: 'declined' }] },
    { id: 'z', summary: '偽の招待', description: '<a href="https://zoom.us@evil.example/x">参加</a>', start: { dateTime: `2026-11-05T16:30:00${offset}` }, end: { dateTime: `2026-11-05T16:45:00${offset}` } },
    { id: 'c', summary: 'キックオフ', conferenceData: { videoEntryPoint: { uri: 'https://meet.google.com/abc-defg-hij' } }, start: { dateTime: `2026-11-05T17:00:00${offset}` }, end: { dateTime: `2026-11-05T17:30:00${offset}` } },
  ],
}

test('予定を一覧し、辞退した予定を除く', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'calendar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false },
  }))
  on('clock.now', () => ({ value: Date.parse(`2026-11-05T15:30:00${offset}`) }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'calendar', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /キックオフ/ }))?.text).toContain('17:00-17:30')
  expect((await ui.find({ type: 'Text', text: /終日/ }))?.text).toContain('終日の締切')
  expect(await ui.find({ type: 'Text', text: /辞退/ })).toBeUndefined()
  await ui.unmount()
  expect(statuses.at(-1)).toContain('偽の招待')
})

test('o で次の会議を開き、許可していない URL は開かない', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'calendar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false },
  }))
  on('clock.now', () => ({ value: Date.parse(`2026-11-05T15:30:00${offset}`) }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    opened.push(...e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'calendar', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'row:z' }))?.text).not.toContain('Zoom')
  await ui.press({ key: 'join-next' })

  expect(await ui.find({ type: 'Text', text: /ペインを閉じる/ })).toBeUndefined()
  await ui.press({ key: 'help' })
  expect(await ui.find({ type: 'Text', text: /ペインを閉じる/ })).toBeDefined()
  await ui.press({ key: 'help' })
  expect(await ui.find({ type: 'Text', text: /ペインを閉じる/ })).toBeUndefined()

  await ui.press({ key: 'toggle-view' })
  await ui.press({ key: 'toggle-view' })
  expect((await ui.find({ type: 'Text', text: /いま/ }))?.text).toContain('15:30')
  expect((await ui.find({ type: 'Text', text: /空き/ }))?.text).toContain('1時間')

  await ui.unmount()
  expect(opened).toEqual(['open', 'https://meet.google.com/abc-defg-hij'])
})

test('取得に失敗するとエラーをペインに出す', async ($, on) => {
  on('command.register', () => ({ value: { command: 'calendar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: 'not connected' }], isError: true },
  }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'calendar', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /取得エラー/ }))?.text).toContain('not connected')
  await ui.unmount()
})

test('j / k の移動先', () => {
  const keys = ['row:a', 'row:b', 'row:c']

  expect(pickRow(keys, '', 'row:b', 1)).toBe('row:b')
  expect(pickRow(keys, 'row:b', 'row:b', 1)).toBe('row:c')
  expect(pickRow(keys, 'row:b', 'row:b', -1)).toBe('row:a')
  expect(pickRow(keys, 'row:c', 'row:b', 1)).toBe('row:c')
  expect(pickRow(keys, 'row:a', 'row:b', -1)).toBe('row:a')
})
