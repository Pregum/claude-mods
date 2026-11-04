import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'workspace-sessions',
  component: 'Pane',
  requestId: 'workspace-sessions',
  props: {
    title: 'セッション',
    isFocused: true,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const VIEW = { ...PANE, requestId: 'workspace-sessions-view' } as const

const NOW = Date.parse('2026-11-03T02:00:00Z')
const P = '/h/.claude/projects'
const BG = 'aaaa1111-0000-0000-0000-000000000000'
const TERM = 'bbbb2222-0000-0000-0000-000000000000'
const SELF = 'cccc3333-0000-0000-0000-000000000000'
const OLD = 'dddd4444-0000-0000-0000-000000000000'
const SIBLING = 'eeee5555-0000-0000-0000-000000000000'
const UNTITLED = '99990000-0000-0000-0000-000000000000'

const agents = [
  { pid: 11, id: 'aaaa1111', cwd: '/w/repo', kind: 'background', sessionId: BG, name: 'バックの仕事', status: 'busy', state: 'working', startedAt: NOW - 60_000 },
  { pid: 12, cwd: '/w/repo/.claude/worktrees/feat', kind: 'interactive', sessionId: TERM, name: 'feat-term', status: 'idle', startedAt: NOW - 600_000 },
  { pid: 13, id: 'cccc3333', cwd: '/w/repo', kind: 'background', sessionId: SELF, name: 'このセッション', status: 'busy', state: 'working', startedAt: NOW },
  { pid: 14, cwd: '/elsewhere', kind: 'interactive', sessionId: 'ffff', name: 'よその仕事', status: 'idle', startedAt: NOW },
]

const tail = [
  '{"type":"user","origin":{"kind":"human"},"timestamp":"2026-11-03T01:50:00Z","message":{"role":"user","content":"README を直して"}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}',
  '{"type":"assistant","timestamp":"2026-11-03T01:55:00Z","message":{"role":"assistant","content":[{"type":"text","text":"README を直しました"}]}}',
].join('\n')

const queuedTail = [
  tail,
  '{"type":"attachment","timestamp":"2026-11-03T01:58:00Z","attachment":{"type":"queued_command","prompt":"ついでに CHANGELOG も","origin":{"kind":"human"}}}',
].join('\n')

type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ok = (stdout: string): Ran => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** エンジンの代わり。何が起きたかを返す */
const fakeHost = (on: On, tailText = tail) => {
  const seen = {
    sends: [] as string[],
    toasts: [] as string[],
    copies: [] as string[],
    closed: [] as string[],
    opened: [] as { id: string; columns?: number; rows?: number; focus?: true; closeOnEscape?: true }[],
  }
  on('ui.open', (_, e) => {
    seen.opened.push({ id: e.id, columns: e.columns, rows: e.rows, focus: e.focus, closeOnEscape: e.closeOnEscape })
    return { value: { isPlaced: true } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.id', () => ({ value: SELF }))
  on('session.root', () => ({ value: '/w/repo' }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    seen.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.close', (_, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({
    value: e.path === '/h/.claude/sessions/11.json' ? '{"bridgeSessionId":"session_ABC"}' : '{}',
  }))
  on('fs.list', (_, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })
    if (e.path === P) {
      return { value: [dir('-w-repo'), dir('-w-repo--claude-worktrees-feat'), dir('-w-repo-old'), dir('-x')] }
    }
    if (e.path === `${P}/-w-repo`) {
      return {
        value: [
          file(`${BG}.jsonl`, NOW - 30_000),
          file(`${SELF}.jsonl`, NOW),
          file(`${OLD}.jsonl`, NOW - 2 * 86_400_000),
          file(`${UNTITLED}.jsonl`, NOW - 3 * 86_400_000),
        ],
      }
    }
    if (e.path === `${P}/-w-repo--claude-worktrees-feat`) return { value: [file(`${TERM}.jsonl`, NOW - 120_000)] }
    if (e.path === `${P}/-w-repo-old`) return { value: [file(`${SIBLING}.jsonl`, NOW - 1000)] }
    return { value: [] }
  })
  on('process.run', (_, e) => {
    const [bin, ...args] = e.argv
    if (bin === 'git' && args[0] === 'rev-parse') return { value: ok('/w/repo/.git\n') }
    if (bin === 'git' && args[0] === 'worktree') {
      return { value: ok('worktree /w/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /w/repo/.claude/worktrees/feat\nHEAD 2\n') }
    }
    if (bin === 'claude' && args[0] === 'agents') return { value: ok(JSON.stringify(agents)) }
    if (bin === 'grep' && args.includes('-o') && args.includes('-m')) {
      return {
        value: ok(
          [
            `${P}/-w-repo/${OLD}.jsonl:"cwd":"/w/repo"`,
            `${P}/-w-repo/${UNTITLED}.jsonl:"cwd":"/w/repo"`,
            `${P}/-w-repo/${BG}.jsonl:"cwd":"/w/repo"`,
            `${P}/-w-repo-old/${SIBLING}.jsonl:"cwd":"/w/repo-old"`,
          ].join('\n'),
        ),
      }
    }
    if (bin === 'grep' && args.includes('-o')) {
      return { value: ok(`${P}/-w-repo/${OLD}.jsonl:"aiTitle":"昔の\\"調べもの\\""\n`) }
    }
    if (bin === 'grep' && args.includes('-m')) {
      // 題名も履歴も無いもの: 先頭の user 行 (内部の行のあとにスラッシュコマンド)
      return {
        value: ok(
          [
            `${P}/-w-repo/${UNTITLED}.jsonl:{"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>x</local-command-caveat>"}}`,
            `${P}/-w-repo/${UNTITLED}.jsonl:{"type":"user","message":{"content":"<command-name>/deploy</command-name><command-args>prod</command-args>"}}`,
          ].join('\n'),
        ),
      }
    }
    if (bin === 'grep') return { value: { ...ok(''), exitCode: 1 } }
    if (bin === 'tail') return { value: ok(`truncated…\n${tailText}\n`) }
    return { value: { ...ok(''), exitCode: 127, stderr: `no ${bin}` } }
  })
  on('session.send', (_, e) => {
    seen.sends.push(`${e.to} ${e.text}`)
    return { isDelivered: true }
  })
  return seen
}

const README_ASK = /README を直して/
const README_DONE = /README を直しました/

test('このワークスペースのセッションだけを並べる', async ($, on) => {
  fakeHost(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /バックの仕事/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feat-term/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /このセッション/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /昔の"調べもの"/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/deploy prod/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wt:feat/ })).toBeDefined()
    // よそのリポジトリ (cwd が外、名前だけ似たフォルダ) は出さない
    expect(await ui.find({ type: 'Text', text: /よその仕事/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /eeee5555/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('/ws はエンジンが許す最大の幅と高さを頼んで開き、広い本文に合わせて描く', async ($, on) => {
  const seen = fakeHost(on)
  await $.command.run({
    command: 'ws',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  expect(seen.opened[0]).toMatchObject({ id: 'workspace-sessions', columns: 1000, rows: 1000, focus: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /バックの仕事/ })).toBeDefined()
  await ui.unmount()
})

test('o で一覧と入れ替えて会話を見せ、q で一覧へ戻る', async ($, on) => {
  const seen = fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `row:${BG}` })
  await ui.press({ key: 'open' })
  await ui.unmount()
  expect(seen.closed).toEqual(['workspace-sessions'])
  expect(seen.opened.at(-1)).toMatchObject({
    id: 'workspace-sessions-view',
    focus: true,
    closeOnEscape: true,
    columns: 1000,
  })

  const view = await $.ui.mount({ ...VIEW, surface: 'terminal' })
  expect(await view.find({ type: 'Text', text: /❯ README を直して/ })).toBeDefined()
  expect(await view.find({ type: 'Markdown', text: /README を直しました/ })).toBeDefined()
  expect(await view.find({ key: 'elsewhere' })).toBeDefined()
  await view.press({ key: 'back' })
  expect(seen.closed.at(-1)).toBe('workspace-sessions-view')
  expect(seen.opened.at(-1)).toMatchObject({ id: 'workspace-sessions', focus: true })
  await view.unmount()
})

test('端末で動いているセッションは a を出さず、o でも Web を開かない', async ($, on) => {
  const seen = fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `row:${TERM}` })
  await ui.press({ key: 'open' })
  await ui.unmount()
  expect(seen.opened.at(-1)?.id).toBe('workspace-sessions-view')
  const view = await $.ui.mount({ ...VIEW, surface: 'terminal' })
  expect(await view.find({ key: 'elsewhere' })).toBeUndefined()
  await view.unmount()
})

test('j / k で動いても詳細は広がらず、d で開け閉めし、開いたままなら移った先を出す', async ($, on) => {
  const seen = fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  // 選んでいる行は c (コピー) が何をコピーするかで分かる
  const here = async () => {
    const copies = seen.copies.length
    await ui.press({ key: 'copy' })
    return seen.copies.length > copies ? seen.copies.at(-1) : seen.toasts.at(-1)
  }

  // 並び: 作業中 (新しい順: 自分 → バック) → 待機 (端末) → 過去
  await ui.press({ key: 'next' })
  expect(await here()).toContain('claude attach cccc3333')
  await ui.press({ key: 'next' })
  expect(await here()).toContain('claude attach aaaa1111')
  expect(await ui.find({ type: 'Text', text: README_DONE })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /›/ })).toBeDefined()

  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: README_ASK })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: README_DONE })).toBeDefined()
  // 開いたまま動くと、移った先の詳細
  await ui.press({ key: 'prev' })
  expect(await here()).toContain('claude attach cccc3333')
  expect(await ui.find({ type: 'Text', text: README_DONE })).toBeDefined()
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: README_DONE })).toBeUndefined()

  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect(await here()).toMatch(/別の端末/)
  await ui.press({ key: 'next' })
  expect(await here()).toContain(`claude --resume ${OLD}`)
  // 送れない行で Enter: 詳細の開け閉め
  await ui.press({ key: `row:${OLD}` })
  expect(await ui.find({ type: 'Text', text: README_DONE })).toBeDefined()
  await ui.press({ key: `row:${OLD}` })
  expect(await ui.find({ type: 'Text', text: README_DONE })).toBeUndefined()
  // 端で止まる
  for (let i = 0; i < 3; i += 1) await ui.press({ key: 'next' })
  expect(await here()).toContain(`claude --resume ${UNTITLED}`)
  await ui.unmount()
})

test('Enter か i で表示ペインの送る欄へ進み、送っても続けて打てる', async ($, on) => {
  const seen = fakeHost(on)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'next' })
    await ui.press({ key: `row:${BG}` }) // 選んでいなければ選ぶだけ
    await ui.press({ key: `row:${BG}` }) // 選んでいる行で Enter
    await ui.unmount()
    expect(seen.opened.at(-1)).toMatchObject({ id: 'workspace-sessions-view', closeOnEscape: true })

    const n = seen.sends.length
    const view = await $.ui.mount({ ...VIEW, surface })
    await view.input({ key: `send:${BG}:${n}`, text: 'テストを足して' })
    expect(seen.sends.at(-1)).toContain('テストを足して')
    expect(await view.find({ key: `send:${BG}:${n + 1}` })).toBeDefined()
    await view.unmount()
    seen.opened.length = 0
  }
  expect(seen.sends.length).toBe(3)
})

test('mobile には送る欄も i も無い', async ($, on) => {
  const seen = fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'type' })).toBeUndefined()
  await ui.press({ key: `row:${BG}` })
  await ui.press({ key: `row:${BG}` })
  expect(seen.opened).toEqual([])
  await ui.press({ key: 'open' })
  await ui.unmount()
  const view = await $.ui.mount({ ...VIEW, surface: 'mobile' })
  expect(await view.find({ type: 'Button', key: 'type' })).toBeUndefined()
  expect(await view.find({ key: `send:${BG}:0` })).toBeUndefined()
  await view.unmount()
})

test('自分自身には送る欄を出さず、開くも止める', async ($, on) => {
  const seen = fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `row:${SELF}` })
  await ui.press({ key: 'type' })
  expect(seen.toasts.at(-1)).toMatch(/いま見ている/)
  await ui.press({ key: 'open' })
  expect(seen.toasts.at(-1)).toMatch(/いま見ている/)
  expect(seen.opened).toEqual([])
  await ui.unmount()
})

test('q で閉じる。選んでいないときの o は知らせるだけ', async ($, on) => {
  const seen = fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'open' })
  expect(seen.toasts.at(-1)).toMatch(/先に j \/ k で選んで/)
  await ui.press({ key: 'close' })
  expect(seen.closed).toEqual(['workspace-sessions'])
  await ui.unmount()
})

test('作業中に届いた依頼を最後の依頼として見せ、返答はまだと示す', async ($, on) => {
  fakeHost(on, queuedTail)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `row:${BG}` })
  await ui.press({ key: 'detail' })
  expect((await ui.find({ type: 'Text', text: /CHANGELOG/ }))?.text).toBe('ついでに CHANGELOG も')
  expect(await ui.find({ type: 'Text', text: /ひとつ前の依頼へ/ })).toBeDefined()
  await ui.unmount()
})

test('前の版が残した形の違う値は読まない', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: { sessions: 'broken' }, version: 1 } } : next(e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /r で読み込みます/ })).toBeDefined()
  await ui.unmount()
})
