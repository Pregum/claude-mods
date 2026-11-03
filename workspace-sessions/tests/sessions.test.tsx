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

type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ok = (stdout: string): Ran => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const queuedTail = [
  tail,
  '{"type":"attachment","timestamp":"2026-11-03T01:58:00Z","attachment":{"type":"queued_command","prompt":"ついでに CHANGELOG も","origin":{"kind":"human"}}}',
].join('\n')

const fakeHost = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  sends: string[],
  tailText = tail,
) => {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.id', () => ({ value: SELF }))
  on('session.root', () => ({ value: '/w/repo' }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.toast', () => ({ value: undefined }))
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
      return { value: [file(`${BG}.jsonl`, NOW - 30_000), file(`${SELF}.jsonl`, NOW), file(`${OLD}.jsonl`, NOW - 2 * 86_400_000), file(`${UNTITLED}.jsonl`, NOW - 3 * 86_400_000)] }
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
    sends.push(`${e.to} ${e.text}`)
    return { isDelivered: true }
  })
}

test('このワークスペースのセッションだけを並べ、のぞいて送れる', async ($, on) => {
  const sends: string[] = []
  fakeHost(on, sends)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ type: 'Text', text: /バックの仕事/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feat-term/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /このセッション/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /昔の"調べもの"/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wt:feat/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/deploy prod/ })).toBeDefined()
    // よそのリポジトリ (cwd が外、名前だけ似たフォルダ) は出さない
    expect(await ui.find({ type: 'Text', text: /よその仕事/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /eeee5555/ })).toBeUndefined()

    await ui.press({ key: `row:${BG}` })
    expect((await ui.find({ type: 'Text', text: /README を直して/ }))?.text).toBe('README を直して')
    expect(await ui.find({ type: 'Text', text: /README を直しました/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `open:${BG}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `web:${BG}` })).toBeDefined()

    if (surface !== 'mobile') {
      await ui.input({ key: `send:${BG}:${sends.length}`, text: 'テストを足して' })
      expect(sends.at(-1)).toContain('テストを足して')
    }

    // もう一度押すと畳む
    await ui.press({ key: `row:${BG}` })
    expect(await ui.find({ type: 'Text', text: /README を直して/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(sends.length).toBe(3)
})

test('自分自身には開く・送るを出さない', async ($, on) => {
  fakeHost(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `row:${SELF}` })
  expect(await ui.find({ type: 'Button', key: `open:${SELF}` })).toBeUndefined()
  expect(await ui.find({ key: `send:${SELF}:0` })).toBeUndefined()
  await ui.unmount()
})

test('前の版が残した形の違う値は読まない', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: { sessions: 'broken' }, version: 1 } } : next(e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /「更新」で読み込みます/ })).toBeDefined()
  await ui.unmount()
})

test('作業中に届いた依頼を最後の依頼として見せ、返答はまだと示す', async ($, on) => {
  fakeHost(on, [], queuedTail)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `row:${BG}` })
  expect((await ui.find({ type: 'Text', text: /CHANGELOG/ }))?.text).toBe('ついでに CHANGELOG も')
  expect(await ui.find({ type: 'Text', text: /ひとつ前の依頼へ/ })).toBeDefined()
  await ui.unmount()
})
