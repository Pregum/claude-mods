import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TaskStatus, TurnKind, WnFile, WnMap, WnTask, WnTools, WnTurn } from '../types'
import { COLORS, gaugeCells, hex, pulseAt, railCells, scopeCells } from './scope'
import { shellKind } from './shell'

type Engine = EngineInterface

const PANE = 'where-now'
const TITLE = '今どこ'
const COMMAND = 'where'
const FILE_LIMIT = 200
/** 手で閉じたことを覚えておく ($.store)。次のセッションでも勝手に開かない */
const CLOSED = 'closed'
const BARS = '▁▂▃▄▅▆▇█'
/** 題名つきで並べる依頼の数 */
const RECENT = 5
const SCOPE_ROWS = 4
const GAUGE_WIDTH = 40
/** 動かす間隔。フォーカス中と登場の間だけ動く */
const FRAME_MS = 66
const REVEAL_MS = 620
const KINDS: readonly { kind: TurnKind; label: string; key?: keyof WnTools }[] = [
  { kind: 'edit', label: '編集', key: 'edit' },
  { kind: 'run', label: '実行', key: 'run' },
  { kind: 'read', label: '調査', key: 'read' },
  { kind: 'agent', label: '委任', key: 'agent' },
  { kind: 'talk', label: '会話' },
]
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill'])
const GAUGE_MAX = 24
const ASK_CHARS = 80

// 形を変えたら shape の札を変える: 前の版が残した値を読まずに初期値から始める
const tasks = atom({ plugin: 'where-now', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const files = atom({ plugin: 'where-now', key: 'files' } as const, [], { shape: 'files-1' })
/** マップで選んでいる依頼の番号 (0 始まり)。null はいまの依頼 */
const picked = atom({ plugin: 'where-now', key: 'picked' } as const, null)
const sessionMap = atom({ plugin: 'where-now', key: 'map' } as const, null, { shape: 'map-6' })

// ---- 幅 (全角は 2 マス) ----

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

const widthOf = (ch: string): number => (isWide(ch.codePointAt(0) ?? 0) ? 2 : 1)

const cells = (text: string): number => [...text].reduce((n, ch) => n + widthOf(ch), 0)

/** 収まらなければ、keepEnd ならファイル名の残る末尾を、そうでなければ先頭を残す */
const fit = (text: string, room: number, keepEnd = false): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (cells(flat) <= room) return flat
  const chars = keepEnd ? [...flat].reverse() : [...flat]
  const kept: string[] = []
  let used = 0
  for (const ch of chars) {
    if (used + widthOf(ch) > room - 1) break
    kept.push(ch)
    used += widthOf(ch)
  }
  return keepEnd ? `…${kept.reverse().join('')}` : `${kept.join('')}…`
}

// ---- 計画 ----

const isStatus = (value: string): value is TaskStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed'

const isOk = (ran: { deny?: string; isError?: boolean }): boolean =>
  ran.deny === undefined && !ran.isError

/** TaskList の答えで置き換える。一覧に activeForm は無いので前のものを残す */
const syncTasks = (prev: readonly WnTask[], listed: readonly { id: string; subject: string; status: string }[]): WnTask[] =>
  listed.flatMap(one => {
    if (!isStatus(one.status)) return []
    const activeForm = prev.find(task => task.id === one.id)?.activeForm
    return [{ id: one.id, text: one.subject, status: one.status, ...(activeForm ? { activeForm } : {}) }]
  })

// ---- ファイル ----

const touch = (
  list: readonly WnFile[],
  path: string,
  change: (file: WnFile) => WnFile,
  isSub: boolean,
): WnFile[] => {
  const prev = list.find(file => file.path === path)
  const base = prev ?? { path, reads: 0, writes: 0, running: 0, failed: 0, isSubOnly: isSub }
  const next = change({ ...base, isSubOnly: base.isSubOnly && isSub })
  return [next, ...list.filter(file => file.path !== path)].slice(0, FILE_LIMIT)
}

const relativeTo = (root: string, path: string): string =>
  root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

async function rootOf($: Engine): Promise<string> {
  return $.session.root().catch(() => '')
}

// ---- ミニマップ ----

/** ツールの分類 */
const toolKind = (tool: string, input: Record<string, unknown> | undefined): keyof WnTools => {
  if (EDIT_TOOLS.has(tool)) return 'edit'
  if (AGENT_TOOLS.has(tool)) return 'agent'
  if (READ_TOOLS.has(tool)) return 'read'
  const command = input?.command
  return tool === 'Bash' && typeof command === 'string' ? shellKind(command) : 'run'
}

/** 依頼の中身の分類。一番残るものを優先する: 編集 > 委任 > 実行 > 調査 > 会話 */
const kindOf = (tools: WnTools): TurnKind => {
  if (tools.edit > 0) return 'edit'
  if (tools.agent > 0) return 'agent'
  if (tools.run > 0) return 'run'
  return tools.read > 0 ? 'read' : 'talk'
}

type Row = {
  role: string
  text: string
  toolUses: readonly { tool: string; input?: Record<string, unknown> }[]
  toolResults?: readonly unknown[]
}

const askOf = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, ASK_CHARS)

/** 人の依頼ごとの題名・重さ・分類。< で始まる文は engine が差し込んだもの */
const turnsOf = (messages: readonly Row[]): WnTurn[] => {
  const turns: { text: string; weight: number; tools: WnTools }[] = []
  for (const message of messages) {
    const text = askOf(message.text)
    const isAsk =
      message.role === 'user' && !message.toolResults?.length && text !== '' && !text.startsWith('<')
    if (isAsk) {
      turns.push({ text, weight: 1, tools: { edit: 0, run: 0, read: 0, agent: 0 } })
      continue
    }
    const last = turns.at(-1)
    if (!last) continue
    last.weight += message.toolUses.length
    for (const use of message.toolUses) last.tools[toolKind(use.tool, use.input)] += 1
  }
  return turns.map(turn => ({ ...turn, kind: kindOf(turn.tools) }))
}

const barOf = (weight: number, max: number): string =>
  BARS[Math.min(BARS.length - 1, Math.ceil((weight / Math.max(1, max)) * BARS.length) - 1)] ?? '▁'

const colorOf = (kind: TurnKind): string => hex(COLORS[kind])

const padTo = (text: string, room: number): string =>
  `${text}${' '.repeat(Math.max(0, room - cells(text)))}`

const lengthOf = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間${minutes % 60}分`
  return `${Math.floor(hours / 24)}日${hours % 24}時間`
}

/** Claude Code がプロジェクトのフォルダ名にするときの書き方: 英数字以外は '-' */
const encodePath = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-')

/** 人の依頼の行の uuid を、古い順に題名つきで。uuid は会話の行の requestId と同じ */
const humanRows = (stdout: string): { id: string; text: string }[] =>
  stdout.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line) as {
        type?: string
        uuid?: string
        origin?: { kind?: string }
        message?: { content?: unknown }
      }
      if (row.type !== 'user' || row.origin?.kind !== 'human' || !row.uuid) return []
      const content = row.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(block => (block as { text?: string }).text ?? '').join('\n')
            : ''
      return [{ id: row.uuid, text: askOf(text) }]
    } catch {
      return []
    }
  })

/** トランスクリプトから依頼の id を引く。読めなければ id なしのまま (描かれた行だけ飛べる) */
async function withIds($: Engine, turns: readonly WnTurn[]): Promise<WnTurn[]> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const id = await $.session.id()
    const dirs = [...new Set([await $.session.root(), await $.session.cwd()])].map(encodePath)
    for (const dir of dirs) {
      const path = `${home}/.claude/projects/${dir}/${id}.jsonl`
      const ran = await $.process.run(['grep', '-F', '"kind":"human"', path], { timeoutMs: 10000 })
      if (ran.exitCode !== 0) continue
      const rows = humanRows(ran.stdout)
      let from = 0
      return turns.map(turn => {
        const at = rows.findIndex((row, i) => i >= from && row.text === turn.text)
        if (at < 0) return turn
        from = at + 1
        return { ...turn, id: rows[at]?.id ?? '' }
      })
    }
  } catch {
    // 下で id なしのまま返す
  }
  return [...turns]
}

async function refreshMap($: Engine): Promise<void> {
  try {
    // summary は手元の推定だけで済み、API へのリクエストは出ない
    const [messages, usage] = await Promise.all([
      $.session.messages(),
      $.session.usage({ breakdown: 'summary' }),
    ])
    const tokens = usage.context.tokens
    const threshold = usage.context.breakdown?.autoCompactThreshold
    const map: WnMap = {
      turns: await withIds($, turnsOf(messages)),
      startedAt: usage.startedAt,
      ...(usage.context.percent !== undefined ? { percent: usage.context.percent } : {}),
      ...(tokens !== undefined && threshold ? { compact: { tokens, threshold } } : {}),
    }
    await update($, sessionMap, () => map)
  } catch {
    // 読めなければ前の帯のまま
  }
}

// ---- 飛ぶ・戻す ----

/**
 * 依頼の題名から transcript の行の id を引く。行の id は描かれたときにしか分からない。
 * 同じ文の依頼があるので、題名ごとに描かれた順で持つ
 */
const rowIds = new Map<string, string[]>()

const noteRow = (text: string, id: string): void => {
  const key = askOf(text)
  const ids = rowIds.get(key) ?? []
  if (!ids.includes(id)) rowIds.set(key, [...ids, id])
}

async function currentAt($: Engine): Promise<number> {
  const map = await read($, sessionMap)
  const last = (map?.turns.length ?? 1) - 1
  return Math.min(last, (await read($, picked)) ?? last)
}

async function movePick($: Engine, by: number): Promise<void> {
  const map = await read($, sessionMap)
  if (!map || map.turns.length === 0) return
  const at = await currentAt($)
  const next = Math.min(map.turns.length - 1, Math.max(0, at + by))
  await update($, picked, () => (next === map.turns.length - 1 ? null : next))
  // フォーカスの帯も一緒に動かす。動かなくても困らないので結果は見ない
  await $.ui.focus({ requestId: PANE, key: `turn:${next}` }).catch(() => undefined)
  await $.ui.scroll({ in: PANE, to: { key: `turn:${next}` } }).catch(() => undefined)
}

/**
 * 依頼の行へ会話をスクロールする。会話の行は人の操作に答えている間しか動かないので、
 * 押された処理の中で同期的に呼ぶ (await を挟むと not person-initiated で断られる)
 */
const jump = ($: Engine, turns: readonly WnTurn[], at: number): void => {
  const turn = turns[at]
  if (!turn) return
  const same = turns.slice(0, at).filter(one => one.text === turn.text).length
  const id = turn.id ?? rowIds.get(turn.text)?.[same]
  if (!id) {
    $.ui.toast('この依頼の場所が分かりませんでした')
    return
  }
  void $.ui
    .scroll({ to: { requestId: id }, block: 'start' })
    .then(moved => {
      if ('deny' in moved && moved.deny) $.ui.toast(`飛べませんでした: ${moved.deny}`)
    })
    .catch((err: unknown) => {
      $.ui.toast(`飛べませんでした: ${err instanceof Error ? err.message : String(err)}`)
    })
}

/** 本体のコマンドへ渡す。途中の地点からの fork は mod から呼べないので /rewind と /branch を使う */
async function runCommand($: Engine, command: string): Promise<void> {
  try {
    await $.command.run({ command })
  } catch (err) {
    $.ui.toast(`/${command} を開けませんでした: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- 動き ----

/**
 * blit に渡す今の絵。描くたびに描画が更新する。モジュールの変数なので読み直しで消えるが、
 * 次の描画で戻る。Raster の無い画面では undefined のまま
 */
let live: { turns: readonly WnTurn[]; at: number; columns: number; isFocused: boolean } | undefined
/** 登場の始まり。動いていなければ undefined */
let revealFrom: number | undefined

const revealOf = (now: number): number =>
  revealFrom === undefined ? 1 : Math.min(1, (now - revealFrom) / REVEAL_MS)

/** 選んでいる列と行を脈打たせ、登場の間は全体を描き直す。止まっているときは何もしない */
async function tick($: Engine): Promise<void> {
  const frame = live
  if (!frame || (!frame.isFocused && revealFrom === undefined)) return
  const now = await $.clock.now()
  const reveal = revealOf(now)
  const pulse = frame.isFocused ? pulseAt(now) : 0
  const blit = (key: string, columns: number, rows: number, cells: string) =>
    $.ui.blit({ requestId: PANE, key, columns, rows, cells }).catch(() => undefined)
  await blit(
    'scope',
    frame.columns,
    SCOPE_ROWS,
    scopeCells({ turns: frame.turns, at: frame.at, columns: frame.columns, rows: SCOPE_ROWS, pulse, reveal }),
  )
  const turn = frame.turns[frame.at]
  if (turn) await blit('rail', 1, 1, railCells(COLORS[turn.kind], pulse))
  if (reveal >= 1) revealFrom = undefined
}

// ---- 開け閉め ----

async function openPane($: Engine): Promise<void> {
  await $.store.delete(CLOSED)
  // プロンプトが空のときだけ通る。/where の直後は空なのでキーが移る
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
  revealFrom = await $.clock.now()
}

async function closePane($: Engine): Promise<void> {
  live = undefined
  await $.store.set(CLOSED, true)
  await $.ui.close({ id: PANE })
}

/**
 * /where: 出ていなければ開き、出ていてキーが無ければキーを渡す。キーを持っていれば閉じる。
 * 幅待ちのペインは出ていないので開く
 */
async function togglePane($: Engine): Promise<void> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  await (pane?.isPlaced && pane.isFocused ? closePane($) : openPane($))
}

// ---- フック ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '「今どこ」ペインを開いてキーを渡す。キーがあれば閉じる',
    })
    // 手で閉じていたら開かない。頼まれずに開くペインは幅が足りるまで待つ
    if (!(await $.store.get(CLOSED))) void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(FRAME_MS, () => void tick($))
    const done = await next(e)
    await refreshMap($)
    return done
  })

  on('command.run', { command: COMMAND }, async $ => {
    await togglePane($)
    return {}
  })

  // ctrl+x x や閉じる印で閉じたときも覚える
  on('ui.close', { id: PANE }, async ($, e, next) => {
    live = undefined
    await $.store.set(CLOSED, true)
    return next(e)
  })

  // 人の依頼で切り替える。サブエージェントの開始と、文の無い続きでは消さない
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      await update($, files, () => [])
    }
    const done = await next(e)
    if (e.agentId === undefined) await refreshMap($)
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // 中断で終わりを聞けなかった呼び出しを、動いたままにしない
    if (e.agentId === undefined) {
      await update($, files, list => list.map(file => ({ ...file, running: 0 })))
      await refreshMap($)
    }
    return done
  })

  on('tool.call', async ($, e, next) => {
    const isSub = e.agentId !== undefined

    if (e.tool === 'Read' || e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit') {
      const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
      const isRead = e.tool === 'Read'
      await update($, files, list =>
        touch(list, path, file => ({ ...file, running: file.running + 1 }), isSub),
      )
      let ok = false
      try {
        const ran = await next(e)
        ok = isOk(ran)
        return ran
      } finally {
        await update($, files, list =>
          touch(
            list,
            path,
            file => ({
              ...file,
              running: Math.max(0, file.running - 1),
              reads: file.reads + (ok && isRead ? 1 : 0),
              writes: file.writes + (ok && !isRead ? 1 : 0),
              failed: file.failed + (ok ? 0 : 1),
            }),
            isSub,
          ),
        )
      }
    }

    const ran = await next(e)
    if (!isOk(ran)) return ran

    // TodoWrite はエージェントごとの一覧なので、本体のものだけ見る
    if (e.tool === 'TodoWrite' && !isSub) {
      const written = e.todos.map((todo, i) => ({
        id: String(i),
        text: todo.content,
        activeForm: todo.activeForm,
        status: todo.status,
      }))
      await update($, tasks, () => written)
    }
    if (e.tool === 'TaskCreate') {
      const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
      if (id !== undefined) {
        const task: WnTask = {
          id,
          text: e.subject,
          status: 'pending',
          ...(e.activeForm ? { activeForm: e.activeForm } : {}),
        }
        await update($, tasks, list => [...list.filter(one => one.id !== id), task])
      }
    }
    if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject, activeForm } = e
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(one => one.id !== taskId)
          : list.map(one =>
              one.id === taskId
                ? {
                    ...one,
                    ...(status ? { status } : {}),
                    ...(subject ? { text: subject } : {}),
                    ...(activeForm ? { activeForm } : {}),
                  }
                : one,
            ),
      )
    }
    if (e.tool === 'TaskList') {
      const listed = (ran.result as { tasks?: { id: string; subject: string; status: string }[] } | undefined)?.tasks
      if (listed) await update($, tasks, prev => syncTasks(prev, listed))
    }
    return ran
  })

  // 依頼の行が描かれたら id を覚える (描き方は変えない)
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.requestId) noteRow(e.props.text, e.requestId)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Raster = e.surface === 'terminal' && 'Raster' in els ? els.Raster : undefined
    const map = await read($, sessionMap)
    const chosen = await read($, picked)
    const now = await $.clock.now()
    const plan = await read($, tasks)
    const touched = await read($, files)
    const root = await rootOf($)
    const width = Math.max(16, e.props.bodyColumns)

    const doneCount = plan.filter(task => task.status === 'completed').length
    const readCount = touched.filter(file => file.reads > 0 && file.writes === 0).length
    const writeCount = touched.filter(file => file.writes > 0).length

    const at = map ? Math.min(map.turns.length - 1, chosen ?? map.turns.length - 1) : 0

    const isFocused = e.props.isFocused
    const scopeWidth = Math.min(512, width)
    live = map && Raster ? { turns: map.turns, at, columns: scopeWidth, isFocused } : undefined
    const pulse = isFocused ? pulseAt(now) : 0

    const toolCount = (turn: WnTurn) => turn.weight - 1
    const countsOf = (turns: readonly WnTurn[]) =>
      KINDS.flatMap(one => {
        if (!one.key) return []
        const key = one.key
        const count = turns.reduce((sum, turn) => sum + turn.tools[key], 0)
        return count > 0 ? [{ ...one, count }] : []
      })

    /** 見出し: 何の画面かと、3 つの数字 */
    const header = (data: WnMap) => {
      const total = data.turns.reduce((sum, turn) => sum + toolCount(turn), 0)
      const length = lengthOf(now - data.startedAt)
      const title = '◆ 今どこ'
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text bold color="claude">{title}</Text>
            <Text bold>{length}</Text>
            <Text bold>{String(data.turns.length)}<Text dimColor> 依頼</Text></Text>
            <Text bold>{String(total)}<Text dimColor> ツール</Text></Text>
          </Box>
        </Box>
      )
    }

    /** 全体マップ。Raster の無い画面は 1 行の帯にする */
    const scope = (data: WnMap) => {
      if (Raster) {
        return (
          <Raster
            key="scope"
            columns={scopeWidth}
            rows={SCOPE_ROWS}
            cells={scopeCells({
              turns: data.turns,
              at,
              columns: scopeWidth,
              rows: SCOPE_ROWS,
              pulse,
              reveal: revealOf(now),
            })}
          />
        )
      }
      const max = Math.max(1, ...data.turns.map(turn => turn.weight))
      const room = Math.max(1, width)
      const shown = data.turns.slice(-room)
      const shift = data.turns.length - shown.length
      return (
        <Box flexDirection="row">
          {shown.map((turn, i) => (
            <Text color={colorOf(turn.kind)} {...(i + shift === at ? { inverse: true } : {})}>
              {barOf(turn.weight, max)}
            </Text>
          ))}
        </Box>
      )
    }

    /** マップの下の目盛りと、選んでいる依頼の内訳 */
    const ruler = (data: WnMap) => {
      const turn = data.turns[at]
      if (!turn) return undefined
      const left = `#${at + 1}/${data.turns.length}`
      return (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          <Text bold color={colorOf(turn.kind)}>{left}</Text>
          {countsOf([turn]).map(one => (
            <Text color={colorOf(one.kind)}>{`${one.label} ${one.count}`}</Text>
          ))}
          {toolCount(turn) === 0 && <Text dimColor>会話のみ</Text>}
        </Box>
      )
    }

    const legend = (data: WnMap) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {countsOf(data.turns).map(one => (
          <Text color={colorOf(one.kind)}>{`■ ${one.label} ${one.count}`}</Text>
        ))}
      </Box>
    )

    /**
     * 自動 compact までどれだけ進んだか。右端が compact の走る地点で、右へ進むほど赤い。
     * 自動 compact が切れているときは、ウィンドウの使用率を出す
     */
    const gauge = (data: WnMap) => {
      const limit = data.compact
      const percent = limit
        ? Math.min(100, Math.round((limit.tokens / limit.threshold) * 100))
        : (data.percent ?? 0)
      const label = limit ? 'compact ' : '文脈 '
      const left = limit ? limit.threshold - limit.tokens : 0
      const tail = ` ${percent}%${limit ? (left > 0 ? ` あと${Math.round(left / 1000)}k` : ' まもなく') : ''}`
      const room = Math.min(GAUGE_WIDTH, Math.max(4, width - cells(label) - cells(tail)))
      if (Raster) {
        return (
          <Box flexDirection="row">
            <Text dimColor>{label}</Text>
            <Raster key="gauge" columns={room} rows={1} cells={gaugeCells(percent, room, limit !== undefined)} />
            <Text bold>{tail}</Text>
          </Box>
        )
      }
      const used = Math.min(room, Math.round((percent / 100) * room))
      return (
        <Text dimColor>{`${label}${'█'.repeat(used)}${'░'.repeat(room - used)}${limit ? '▕' : ''}${tail}`}</Text>
      )
    }

    /** 選んでいる依頼のまわり。押すと会話のその行へ飛ぶ */
    const turnRow = (data: WnMap, turn: WnTurn, index: number) => {
      const isHere = index === at
      const color = colorOf(turn.kind)
      const hasRail = isHere && Raster !== undefined
      const number = String(index + 1).padStart(String(data.turns.length).length)
      const head = `${isHere && !Raster ? '›' : ' '}${number} `
      const tail = ` ${String(toolCount(turn)).padStart(3)}`
      const room = Math.max(4, width - cells(head) - cells(tail) - 2)
      return (
        <Box flexDirection="row" key={`row:${index}`}>
          {hasRail && Raster ? (
            <Raster key="rail" columns={1} rows={1} cells={railCells(COLORS[turn.kind], pulse)} />
          ) : (
            <Text color={color} dimColor={!isHere}>{Raster ? '▏' : ' '}</Text>
          )}
          <Button
            key={`turn:${index}`}
            plain
            {...(isHere ? { autoFocus: true as const } : {})}
            onPress={() => jump($, data.turns, index)}
          >
            <Text dimColor={!isHere} bold={isHere}>{head}</Text>
            <Text bold={isHere} dimColor={!isHere}>{padTo(fit(turn.text, room), room)}</Text>
            <Text color={color} dimColor={!isHere}>{tail}</Text>
          </Button>
        </Box>
      )
    }

    const shownTurns = (data: WnMap) => {
      const start = Math.max(0, Math.min(at - Math.floor(RECENT / 2), data.turns.length - RECENT))
      return data.turns.slice(start, start + RECENT).map((turn, i) => turnRow(data, turn, start + i))
    }

    const mapKeys = (data: WnMap) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="prev" plain dimColor hotkey="k" label="前" onPress={() => void movePick($, -1)} />
        <Button key="next" plain dimColor hotkey="j" label="次" onPress={() => void movePick($, 1)} />
        <Button key="jump" plain dimColor hotkey="g" label="飛ぶ" onPress={() => jump($, data.turns, at)} />
        <Button key="rewind" plain dimColor hotkey="r" label="巻き戻す" onPress={() => void runCommand($, 'rewind')} />
        <Button key="branch" plain dimColor hotkey="b" label="今から分岐" onPress={() => void runCommand($, 'branch')} />
      </Box>
    )

    const taskRow = (task: WnTask) => {
      const room = width - 2
      if (task.status === 'in_progress') {
        return (
          <Text color="claude" bold>{`▶ ${fit(task.activeForm ?? task.text, room)}`}</Text>
        )
      }
      return task.status === 'completed' ? (
        <Text dimColor>{`✓ ${fit(task.text, room)}`}</Text>
      ) : (
        <Text>{`○ ${fit(task.text, room)}`}</Text>
      )
    }

    const fileRow = (file: WnFile) => {
      const count = file.reads + file.writes
      const tail = [count > 1 ? `×${count}` : '', file.isSubOnly ? 'sub' : ''].filter(Boolean).join(' ')
      const room = width - 2 - (tail ? cells(tail) + 1 : 0)
      const name = fit(relativeTo(root, file.path), room, true)
      const line = `${name}${tail ? ` ${tail}` : ''}`
      if (file.running > 0) return <Text color="warning">{`● ${line}`}</Text>
      if (count === 0) return <Text color="error">{`✗ ${line}`}</Text>
      if (file.writes > 0) return <Text color="success">{`✎ ${line}`}</Text>
      return <Text dimColor>{`· ${line}`}</Text>
    }

    return (
      <Box flexDirection="column">
        {map && header(map)}
        {map && map.turns.length > 0 && scope(map)}
        {map && map.turns.length > 0 && ruler(map)}
        {map && map.turns.length > 0 && legend(map)}
        {map && (map.compact || map.percent !== undefined) && gauge(map)}
        <Text> </Text>
        {map && map.turns.length > 0 && shownTurns(map)}
        {map && map.turns.length > 0 && mapKeys(map)}
        <Text> </Text>
        <Text dimColor>{`─ 計画${plan.length > 0 ? ` ${'▰'.repeat(doneCount)}${'▱'.repeat(plan.length - doneCount)} ${doneCount}/${plan.length}` : ''}`}</Text>
        {plan.length === 0 && <Text dimColor>計画はありません</Text>}
        {plan.map(taskRow)}
        <Text dimColor>{`─ このターン · 読 ${readCount} · 書 ${writeCount}`}</Text>
        {touched.length === 0 && <Text dimColor>まだ触っていません</Text>}
        {touched.map(fileRow)}
        <Button key="close" plain dimColor hotkey="q" label="閉じる" onPress={() => void closePane($)} />
      </Box>
    )
  })
}
