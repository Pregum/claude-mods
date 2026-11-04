import type { EngineInterface } from 'claude-code'

import type { WsConvo, WsPeek, WsSession, WsSnapshot, WsTurn } from '../types'

type Engine = EngineInterface

/** 過去のトランスクリプトを何件まで並べるか */
const PAST_LIMIT = 30
/** 表示ペインに出す発言の数と、1 発言の長さ */
const TURN_LIMIT = 16
const TURN_CHARS = 4000

/** Claude Code がプロジェクトのフォルダ名にするときの書き方: 英数字以外は '-' */
export const encodePath = (path: string): string =>
  path.replace(/[^A-Za-z0-9]/g, '-')

const basename = (path: string): string =>
  path.replace(/\/+$/, '').split('/').pop() ?? path

const isInside = (cwd: string, trees: readonly string[]): boolean =>
  trees.some(tree => cwd === tree || cwd.startsWith(`${tree}/`))

/** ワークスペースの根から見た場所の短い名前 */
export const placeOf = (root: string, cwd: string): string => {
  if (cwd === root) return ''
  const wt = `${root}/.claude/worktrees/`
  if (cwd.startsWith(wt)) return `wt:${cwd.slice(wt.length).split('/')[0]}`
  if (cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1)
  return basename(cwd)
}

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/**
 * ワークスペースの根 (worktree の中からでも本体) と、git が知っている worktree。
 * git が無いときは起点のフォルダだけ。
 */
export async function workspaceOf(
  $: Engine,
  start: string,
): Promise<{ root: string; trees: string[] }> {
  let root = start.replace(/\/\.claude\/worktrees\/.*$/, '')
  const trees = new Set<string>()
  try {
    const common = await $.process.run(
      ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: start, timeoutMs: 5000 },
    )
    const dir = common.stdout.trim()
    if (common.exitCode === 0 && dir.endsWith('/.git')) root = dir.slice(0, -5)
    const list = await $.process.run(['git', 'worktree', 'list', '--porcelain'], {
      cwd: start,
      timeoutMs: 5000,
    })
    if (list.exitCode === 0) {
      for (const line of list.stdout.split('\n')) {
        if (line.startsWith('worktree ')) trees.add(line.slice('worktree '.length))
      }
    }
  } catch {
    // git が無い・リポジトリの外: 起点のフォルダだけで数える
  }
  trees.add(root)
  return { root, trees: [...trees] }
}

type Agent = {
  pid?: number
  id?: string
  cwd?: string
  kind?: string
  startedAt?: number
  sessionId?: string
  name?: string
  status?: string
  state?: string
}

/** `claude agents --json --all`: 動いている対話・バックグラウンドと、止まったバックグラウンド */
async function listAgents($: Engine, home: string): Promise<Agent[]> {
  const bins = ['claude', `${home}/.local/bin/claude`]
  let last = 'claude が見つかりません'
  for (const bin of bins) {
    try {
      const ran = await $.process.run([bin, 'agents', '--json', '--all'], {
        ...(home ? { cwd: home } : {}),
        timeoutMs: 20000,
      })
      if (ran.exitCode !== 0) {
        last = ran.stderr.trim() || `exit ${ran.exitCode}`
        continue
      }
      const parsed: unknown = JSON.parse(ran.stdout)
      return Array.isArray(parsed) ? (parsed as Agent[]) : []
    } catch (err) {
      last = message(err)
    }
  }
  throw new Error(`claude agents を読めませんでした: ${last}`)
}

/** 動いているセッションの Remote Control のリンク (claude.ai/code) */
async function webUrlOf($: Engine, home: string, pid: number): Promise<string | undefined> {
  try {
    const record = asObject(JSON.parse(await $.fs.read(`${home}/.claude/sessions/${pid}.json`)))
    const bridge = asString(record?.bridgeSessionId)
    return bridge && /^[A-Za-z0-9_]+$/.test(bridge)
      ? `https://claude.ai/code/${bridge}`
      : undefined
  } catch {
    return undefined
  }
}

type Transcript = { path: string; mtimeMs: number }

/**
 * ~/.claude/projects のうち、ワークスペースの根・その下・worktree のフォルダにある
 * トランスクリプト。sessionId ごとに一番新しいもの。
 */
async function transcripts(
  $: Engine,
  home: string,
  root: string,
  trees: readonly string[],
): Promise<Map<string, Transcript>> {
  const base = `${home}/.claude/projects`
  const exact = new Set(trees.map(encodePath))
  // 根の下のフォルダ (worktree も含む) は "-" で続く。よそのリポジトリが混ざりうるので
  // 後でトランスクリプトの cwd で確かめる
  const below = `${encodePath(root)}-`
  const found = new Map<string, Transcript>()
  let dirs
  try {
    dirs = await $.fs.list(base)
  } catch {
    return found
  }
  for (const dir of dirs) {
    if (dir.kind !== 'dir') continue
    if (!exact.has(dir.name) && !dir.name.startsWith(below)) continue
    let files
    try {
      files = await $.fs.list(`${base}/${dir.name}`)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
      const id = file.name.slice(0, -'.jsonl'.length)
      const prev = found.get(id)
      if (!prev || prev.mtimeMs < file.mtimeMs) {
        found.set(id, { path: `${base}/${dir.name}/${file.name}`, mtimeMs: file.mtimeMs })
      }
    }
  }
  return found
}

const FIELD = /^"([A-Za-z]+)":"(.*)"$/

/**
 * トランスクリプトから `"key":"value"` を grep で拾う (ファイルを読み込まずに済む)。
 * 返すのはファイルごとの [key, value] の並び。
 */
async function grepFields(
  $: Engine,
  files: readonly string[],
  keys: readonly string[],
  isFirstOnly: boolean,
): Promise<Map<string, Array<[string, string]>>> {
  const out = new Map<string, Array<[string, string]>>()
  if (files.length === 0) return out
  const pattern = `"(${keys.join('|')})":"([^"\\\\]|\\\\.)*"`
  try {
    const ran = await $.process.run(
      ['grep', '-o', '-H', '-E', ...(isFirstOnly ? ['-m', '1'] : []), pattern, ...files],
      { timeoutMs: 15000 },
    )
    for (const line of ran.stdout.split('\n')) {
      const cut = line.indexOf('.jsonl:')
      if (cut < 0) continue
      const path = line.slice(0, cut + '.jsonl'.length)
      const match = FIELD.exec(line.slice(cut + '.jsonl:'.length))
      if (!match?.[1] || match[2] === undefined) continue
      let value: string
      try {
        value = JSON.parse(`"${match[2]}"`) as string
      } catch {
        continue
      }
      const list = out.get(path) ?? []
      list.push([match[1], value])
      out.set(path, list)
    }
  } catch {
    // grep が無い・時間切れ: 題名なしで並べる
  }
  return out
}

/** 題名の無いセッションは ~/.claude/history.jsonl の最初の依頼で呼ぶ */
async function firstPrompts(
  $: Engine,
  home: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const ran = await $.process.run(
      ['grep', '-F', '-h', ...ids.flatMap(id => ['-e', id]), `${home}/.claude/history.jsonl`],
      { timeoutMs: 10000 },
    )
    for (const line of ran.stdout.split('\n')) {
      let row: Json | undefined
      try {
        row = asObject(JSON.parse(line))
      } catch {
        continue
      }
      const id = asString(row?.sessionId)
      const text = asString(row?.display)
      if (id && text && !out.has(id)) out.set(id, text.replace(/\s+/g, ' ').trim())
    }
  } catch {
    // 履歴が読めない: id で呼ぶ
  }
  return out
}

/** 人の依頼として読める文か。スラッシュコマンドはその名前と引数で呼ぶ */
const openerOf = (text: string): string | undefined => {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim()
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim()
    return args ? `${command} ${args}` : command
  }
  if (text.startsWith('<')) return undefined
  return text.replace(/\s+/g, ' ').trim() || undefined
}

/**
 * 履歴にも残らないもの (`claude -p` や SDK から走らせたもの) は、トランスクリプトの
 * 最初の依頼で呼ぶ。先頭のいくつかの "type":"user" の行だけを grep で取る
 */
async function firstUserTexts(
  $: Engine,
  files: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (files.length === 0) return out
  try {
    const ran = await $.process.run(['grep', '-m', '5', '-H', '-F', '"type":"user"', ...files], {
      timeoutMs: 15000,
    })
    for (const line of ran.stdout.split('\n')) {
      const cut = line.indexOf('.jsonl:')
      if (cut < 0) continue
      const path = line.slice(0, cut + '.jsonl'.length)
      if (out.has(path)) continue
      let row: Json | undefined
      try {
        row = asObject(JSON.parse(line.slice(cut + '.jsonl:'.length)))
      } catch {
        continue
      }
      if (row?.type !== 'user' || row.isMeta === true) continue
      const text = textOf(asObject(row.message)?.content)
      const opener = text ? openerOf(text) : undefined
      if (opener) out.set(path, opener)
    }
  } catch {
    // 読めなければ id で呼ぶ
  }
  return out
}

const rank = (s: WsSession): number =>
  s.isRunning ? (s.status === 'busy' ? 0 : 1) : s.kind === 'past' ? 3 : 2

/** このワークスペースのセッションを、動いているもの → 止まったバックグラウンド → 過去の順に */
export async function collect($: Engine): Promise<WsSnapshot> {
  const home = (await $.env.get('HOME')) ?? ''
  const selfId = await $.session.id()
  const { root, trees } = await workspaceOf($, await $.session.root())
  const [agents, files] = await Promise.all([
    listAgents($, home).catch((err: unknown) => new Error(message(err))),
    transcripts($, home, root, trees),
  ])

  const cwds = await grepFields(
    $,
    [...files.values()].map(file => file.path),
    ['cwd'],
    true,
  )
  const cwdOf = (file: Transcript): string | undefined =>
    cwds.get(file.path)?.find(([key]) => key === 'cwd')?.[1]

  const sessions: WsSession[] = []
  const seen = new Set<string>()

  if (Array.isArray(agents)) {
    for (const agent of agents) {
      const sessionId = asString(agent.sessionId)
      const cwd = asString(agent.cwd)
      if (!sessionId || !cwd || !isInside(cwd, trees) || seen.has(sessionId)) continue
      seen.add(sessionId)
      const isRunning = typeof agent.status === 'string'
      const file = files.get(sessionId)
      const isBackground = agent.kind === 'background'
      sessions.push({
        sessionId,
        ...(isBackground && agent.id ? { shortId: agent.id } : {}),
        name: asString(agent.name) ?? sessionId.slice(0, 8),
        cwd,
        place: placeOf(root, cwd),
        kind: isBackground ? 'background' : 'interactive',
        ...(agent.status ? { status: agent.status } : {}),
        ...(agent.state ? { state: agent.state } : {}),
        isRunning,
        isSelf: sessionId === selfId,
        at: file?.mtimeMs ?? agent.startedAt ?? 0,
        transcript: file?.path ?? `${home}/.claude/projects/${encodePath(cwd)}/${sessionId}.jsonl`,
        ...(isRunning && typeof agent.pid === 'number'
          ? await webUrlOf($, home, agent.pid).then(url => (url ? { webUrl: url } : {}))
          : {}),
      })
    }
  }

  const past = [...files.entries()]
    .filter(([id]) => !seen.has(id))
    .map(([id, file]) => ({ id, file, cwd: cwdOf(file) }))
    .filter((one): one is { id: string; file: Transcript; cwd: string } =>
      one.cwd !== undefined && isInside(one.cwd, trees),
    )
    .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
    .slice(0, PAST_LIMIT)

  const titles = await grepFields(
    $,
    past.map(one => one.file.path),
    ['customTitle', 'agentName', 'aiTitle'],
    false,
  )
  const titleOf = (path: string): string | undefined => {
    const fields = titles.get(path) ?? []
    for (const key of ['customTitle', 'agentName', 'aiTitle']) {
      const hit = fields.filter(([k]) => k === key).pop()
      if (hit) return hit[1]
    }
    return undefined
  }
  const untitled = past.filter(one => titleOf(one.file.path) === undefined).map(one => one.id)
  const prompts = await firstPrompts($, home, untitled)
  const openers = await firstUserTexts(
    $,
    past.filter(one => untitled.includes(one.id) && !prompts.has(one.id)).map(one => one.file.path),
  )

  for (const one of past) {
    sessions.push({
      sessionId: one.id,
      name:
        titleOf(one.file.path) ??
        prompts.get(one.id) ??
        openers.get(one.file.path) ??
        one.id.slice(0, 8),
      cwd: one.cwd,
      place: placeOf(root, one.cwd),
      kind: 'past',
      isRunning: false,
      isSelf: one.id === selfId,
      at: one.file.mtimeMs,
      transcript: one.file.path,
    })
  }

  sessions.sort((a, b) => rank(a) - rank(b) || b.at - a.at)

  return {
    root,
    label: basename(root),
    sessions,
    loadedAt: await $.clock.now(),
    ...(agents instanceof Error ? { error: agents.message } : {}),
  }
}

/** content (文字列、または text ブロックの並び) から読める文だけ */
const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const texts = content
    .map(block => asObject(block))
    .filter(block => block?.type === 'text')
    .map(block => asString(block?.text) ?? '')
    .join('\n')
    .trim()
  return texts || undefined
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\n{3,}/g, '\n\n').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 最後の依頼 (人が打ったもの) と最後の返答を、トランスクリプトの末尾から */
export async function peek($: Engine, session: WsSession): Promise<WsPeek> {
  const base = { sessionId: session.sessionId }
  if (!session.transcript) return { ...base, error: 'トランスクリプトがありません' }
  for (const bytes of [400_000, 3_500_000]) {
    let stdout: string
    try {
      const ran = await $.process.run(['tail', '-c', String(bytes), session.transcript], {
        timeoutMs: 10000,
      })
      if (ran.exitCode !== 0) return { ...base, error: ran.stderr.trim() || 'まだ何も書かれていません' }
      stdout = ran.stdout
    } catch (err) {
      return { ...base, error: message(err) }
    }
    const lines = stdout.split('\n')
    let prompt: string | undefined
    let reply: string | undefined
    let promptAt = -1
    let replyAt = -1
    let at: number | undefined
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line || line[0] !== '{') continue
      let row: Json | undefined
      try {
        row = asObject(JSON.parse(line))
      } catch {
        continue
      }
      if (!row) continue
      const when = Date.parse(asString(row.timestamp) ?? '')
      if (reply === undefined && row.type === 'assistant') {
        const text = textOf(asObject(row.message)?.content)
        if (text) {
          reply = text
          replyAt = i
          if (at === undefined && !Number.isNaN(when)) at = when
        }
      }
      // 人の依頼: 打ったもの (user) と、作業中に届いて差し込まれたもの (queued_command)
      const queued = row.type === 'attachment' ? asObject(row.attachment) : undefined
      const isTyped = row.type === 'user' && asObject(row.origin)?.kind === 'human'
      const isQueued = queued?.type === 'queued_command' && asObject(queued.origin)?.kind === 'human'
      if (prompt === undefined && (isTyped || isQueued)) {
        const text = textOf(isQueued ? queued?.prompt : asObject(row.message)?.content)
        if (text) {
          prompt = text
          promptAt = i
          if (at === undefined && !Number.isNaN(when)) at = when
        }
      }
      if (prompt !== undefined && reply !== undefined) break
    }
    // 依頼が末尾に入っていなければ (長い作業のあと) 一度だけ広く読み直す
    if (prompt === undefined && bytes < 3_500_000) continue
    return {
      ...base,
      ...(prompt ? { prompt: clip(prompt, 240) } : {}),
      ...(reply ? { reply: clip(reply, 700) } : {}),
      isAnswered: reply !== undefined && replyAt > promptAt,
      ...(at !== undefined ? { at } : {}),
    }
  }
  return { ...base, error: '読める発言が見つかりませんでした' }
}

/** 開くためのコマンド。端末で対話中のものは別の端末にいるので無し */
/** トランスクリプトの末尾から、人の依頼と返答の文を古い順に */
export async function conversation($: Engine, session: WsSession): Promise<WsConvo> {
  const base = { sessionId: session.sessionId, turns: [] }
  if (!session.transcript) return { ...base, error: 'トランスクリプトがありません' }
  for (const bytes of [400_000, 3_500_000]) {
    let stdout: string
    try {
      const ran = await $.process.run(['tail', '-c', String(bytes), session.transcript], {
        timeoutMs: 10000,
      })
      if (ran.exitCode !== 0) return { ...base, error: ran.stderr.trim() || 'まだ何も書かれていません' }
      stdout = ran.stdout
    } catch (err) {
      return { ...base, error: message(err) }
    }
    const turns: WsTurn[] = []
    for (const line of stdout.split('\n')) {
      if (line[0] !== '{') continue
      let row: Json | undefined
      try {
        row = asObject(JSON.parse(line))
      } catch {
        continue // tail で切れた先頭の行
      }
      if (!row || row.isSidechain === true) continue
      const queued = row.type === 'attachment' ? asObject(row.attachment) : undefined
      const isTyped = row.type === 'user' && asObject(row.origin)?.kind === 'human'
      const isQueued = queued?.type === 'queued_command' && asObject(queued.origin)?.kind === 'human'
      const content = isQueued ? queued?.prompt : asObject(row.message)?.content
      const role = isTyped || isQueued ? 'you' : row.type === 'assistant' ? 'claude' : undefined
      const text = role ? textOf(content) : undefined
      if (!role || !text) continue
      const turn = { role, text: clip(text, TURN_CHARS) } as const
      const last = turns.at(-1)
      if (last?.role !== turn.role || last.text !== turn.text) turns.push(turn)
    }
    if (turns.length >= TURN_LIMIT || stdout.length < bytes) {
      return { ...base, turns: turns.slice(-TURN_LIMIT) }
    }
  }
  return { ...base, error: 'トランスクリプトが読めませんでした' }
}

export const commandFor = (session: WsSession): string | undefined => {
  if (session.kind === 'past') return `claude --resume ${session.sessionId}`
  if (session.kind === 'background') return `claude attach ${session.shortId ?? session.sessionId.slice(0, 8)}`
  return undefined
}

const shellQuote = (text: string): string =>
  /^[A-Za-z0-9_./:@%+=-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`

export const copyText = (session: WsSession, command: string): string =>
  `cd ${shellQuote(session.cwd)} && ${command}`
