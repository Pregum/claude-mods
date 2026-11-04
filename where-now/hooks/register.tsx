import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TaskStatus, TurnKind, WnFile, WnMap, WnTask, WnTurn } from '../types'

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
const KINDS: readonly { kind: TurnKind; label: string; color?: string }[] = [
  { kind: 'edit', label: '編集', color: 'success' },
  { kind: 'run', label: '実行', color: 'warning' },
  { kind: 'read', label: '調査', color: 'suggestion' },
  { kind: 'agent', label: '委任', color: 'error' },
  { kind: 'talk', label: '会話' },
]
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill'])
const RECENT_BAR = 6
const GAUGE_MAX = 24
const ASK_CHARS = 80

// 形を変えたら shape の札を変える: 前の版が残した値を読まずに初期値から始める
const ask = atom({ plugin: 'where-now', key: 'ask' } as const, '')
const tasks = atom({ plugin: 'where-now', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const files = atom({ plugin: 'where-now', key: 'files' } as const, [], { shape: 'files-1' })
/** マップで選んでいる依頼の番号 (0 始まり)。null はいまの依頼 */
const picked = atom({ plugin: 'where-now', key: 'picked' } as const, null)
const sessionMap = atom({ plugin: 'where-now', key: 'map' } as const, null, { shape: 'map-3' })

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

/** 依頼の中身の分類。一番残るものを優先する: 編集 > 委任 > 実行 > 調査 > 会話 */
const kindOf = (tools: ReadonlySet<string>): TurnKind => {
  const has = (set: ReadonlySet<string>) => [...tools].some(name => set.has(name))
  if (has(EDIT_TOOLS)) return 'edit'
  if (has(AGENT_TOOLS)) return 'agent'
  if (tools.has('Bash')) return 'run'
  if (has(READ_TOOLS)) return 'read'
  return tools.size > 0 ? 'run' : 'talk'
}

type Row = {
  role: string
  text: string
  toolUses: readonly { tool: string }[]
  toolResults?: readonly unknown[]
}

const askOf = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, ASK_CHARS)

/** 人の依頼ごとの題名・重さ・分類。< で始まる文は engine が差し込んだもの */
const turnsOf = (messages: readonly Row[]): WnTurn[] => {
  const turns: { text: string; weight: number; tools: Set<string> }[] = []
  for (const message of messages) {
    const text = askOf(message.text)
    const isAsk =
      message.role === 'user' && !message.toolResults?.length && text !== '' && !text.startsWith('<')
    if (isAsk) {
      turns.push({ text, weight: 1, tools: new Set() })
      continue
    }
    const last = turns.at(-1)
    if (!last) continue
    last.weight += message.toolUses.length
    for (const use of message.toolUses) last.tools.add(use.tool)
  }
  return turns.map(({ text, weight, tools }) => ({ text, weight, kind: kindOf(tools) }))
}

/** 帯の 1 マス。束ねたマスは一番重い依頼の分類 */
type Cell = { from: number; to: number; weight: number; kind: TurnKind }

/** 幅に収まるように束ねる。長いセッションほど帯が伸び、幅いっぱいで束ね始める */
const cellsOfTurns = (turns: readonly WnTurn[], room: number): Cell[] => {
  const size = Math.max(1, Math.ceil(turns.length / Math.max(1, room)))
  const out: Cell[] = []
  for (let i = 0; i < turns.length; i += size) {
    const group = turns.slice(i, i + size)
    const heaviest = group.reduce((a, b) => (b.weight > a.weight ? b : a))
    out.push({
      from: i,
      to: i + group.length - 1,
      weight: group.reduce((sum, one) => sum + one.weight, 0),
      kind: heaviest.kind,
    })
  }
  return out
}

const barOf = (weight: number, max: number): string =>
  BARS[Math.min(BARS.length - 1, Math.ceil((weight / Math.max(1, max)) * BARS.length) - 1)] ?? '▁'

const colorOf = (kind: TurnKind): string | undefined => KINDS.find(one => one.kind === kind)?.color

/** 色ごとにまとめて 1 つの Text にする */
const runsOf = (cellsIn: readonly Cell[], max: number, at: number) => {
  const runs: { text: string; kind: TurnKind; isHere: boolean }[] = []
  for (const cell of cellsIn) {
    const isHere = at >= cell.from && at <= cell.to
    const last = runs.at(-1)
    if (last && last.kind === cell.kind && !last.isHere && !isHere) last.text += barOf(cell.weight, max)
    else runs.push({ text: barOf(cell.weight, max), kind: cell.kind, isHere })
  }
  return runs
}

const padTo = (text: string, room: number): string =>
  `${text}${' '.repeat(Math.max(0, room - cells(text)))}`

const gaugeColor = (percent: number): 'success' | 'warning' | 'error' =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

const lengthOf = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間${minutes % 60}分`
  return `${Math.floor(hours / 24)}日${hours % 24}時間`
}

async function refreshMap($: Engine): Promise<void> {
  try {
    const [messages, usage] = await Promise.all([$.session.messages(), $.session.usage()])
    const map: WnMap = {
      turns: turnsOf(messages),
      startedAt: usage.startedAt,
      ...(usage.context.percent !== undefined ? { percent: usage.context.percent } : {}),
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
}

/** 選んでいる依頼の行へ会話をスクロールする */
async function jump($: Engine, at: number): Promise<void> {
  const map = await read($, sessionMap)
  const turn = map?.turns[at]
  if (!map || !turn) return
  const same = map.turns.slice(0, at).filter(one => one.text === turn.text).length
  const id = rowIds.get(turn.text)?.[same]
  if (!id) {
    $.ui.toast('この依頼の行はまだ描かれていません。会話を一度そこまでスクロールすると飛べます')
    return
  }
  try {
    const moved = await $.ui.scroll({ to: { requestId: id }, block: 'start' })
    if ('deny' in moved && moved.deny) $.ui.toast(`飛べませんでした: ${moved.deny}`)
  } catch (err) {
    $.ui.toast(`飛べませんでした: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 本体のコマンドへ渡す。途中の地点からの fork は mod から呼べないので /rewind と /branch を使う */
async function runCommand($: Engine, command: string): Promise<void> {
  try {
    await $.command.run({ command })
  } catch (err) {
    $.ui.toast(`/${command} を開けませんでした: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- 開け閉め ----

async function openPane($: Engine): Promise<void> {
  await $.store.delete(CLOSED)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function closePane($: Engine): Promise<void> {
  await $.store.set(CLOSED, true)
  await $.ui.close({ id: PANE })
}

/** /where: 出ていれば閉じ、出ていなければ開く。幅待ちのペインは出ていないので開く */
async function togglePane($: Engine): Promise<void> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  await (pane?.isPlaced ? closePane($) : openPane($))
}

// ---- フック ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '「今どこ」ペインを開く・閉じる',
    })
    // 手で閉じていたら開かない。頼まれずに開くペインは幅が足りるまで待つ
    if (!(await $.store.get(CLOSED))) void $.ui.open({ id: PANE, title: TITLE })
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
    await $.store.set(CLOSED, true)
    return next(e)
  })

  // 人の依頼で切り替える。サブエージェントの開始と、文の無い続きでは消さない
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      await update($, ask, () => e.text)
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const map = await read($, sessionMap)
    const chosen = await read($, picked)
    const now = await $.clock.now()
    const asked = await read($, ask)
    const plan = await read($, tasks)
    const touched = await read($, files)
    const root = await rootOf($)
    const width = Math.max(16, e.props.bodyColumns)

    const doneCount = plan.filter(task => task.status === 'completed').length
    const readCount = touched.filter(file => file.reads > 0 && file.writes === 0).length
    const writeCount = touched.filter(file => file.writes > 0).length

    const at = map ? Math.min(map.turns.length - 1, chosen ?? map.turns.length - 1) : 0

    /** 全体の帯。色が中身、高さがツールの数、反転が選んでいる依頼 */
    const strip = (data: WnMap) => {
      const label = `依頼 ${data.turns.length} `
      const cellsIn = cellsOfTurns(data.turns, width - cells(label))
      const max = Math.max(1, ...cellsIn.map(cell => cell.weight))
      return (
        <Box flexDirection="row">
          <Text>{label}</Text>
          {runsOf(cellsIn, max, at).map(run => {
            const color = colorOf(run.kind)
            return (
              <Text
                {...(color ? { color } : { dimColor: true })}
                {...(run.isHere ? { inverse: true } : {})}
              >
                {run.text}
              </Text>
            )
          })}
        </Box>
      )
    }

    const legend = () => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {KINDS.map(one => (
          <Text {...(one.color ? { color: one.color } : { dimColor: true })}>{`■${one.label}`}</Text>
        ))}
      </Box>
    )

    /** コンテキストをどれだけ使ったか */
    const gauge = (percent: number) => {
      const label = '文脈 '
      const tail = ` ${percent}%`
      const room = Math.min(GAUGE_MAX, Math.max(4, width - cells(label) - cells(tail)))
      const used = Math.min(room, Math.round((percent / 100) * room))
      return (
        <Box flexDirection="row">
          <Text>{label}</Text>
          <Text color={gaugeColor(percent)}>{'█'.repeat(used)}</Text>
          <Text dimColor>{`${'░'.repeat(room - used)}${tail}`}</Text>
        </Box>
      )
    }

    /** 選んでいる依頼のまわり。押すと会話のその行へ飛ぶ */
    const turnRow = (data: WnMap, turn: WnTurn, index: number) => {
      const isHere = index === at
      const color = colorOf(turn.kind)
      const head = `${isHere ? '›' : ' '}${String(index + 1).padStart(String(data.turns.length).length)} `
      const tail = ` ${String(turn.weight - 1).padStart(3)}`
      const room = Math.max(4, width - cells(head) - cells(tail) - 2)
      return (
        <Button key={`turn:${index}`} plain onPress={() => void jump($, index)}>
          <Text bold={isHere}>{head}</Text>
          <Text {...(color ? { color } : { dimColor: true })}>{'▌ '}</Text>
          <Text bold={isHere}>{padTo(fit(turn.text, room), room)}</Text>
          <Text dimColor>{tail}</Text>
        </Button>
      )
    }

    const shownTurns = (data: WnMap) => {
      const start = Math.max(0, Math.min(at - Math.floor(RECENT / 2), data.turns.length - RECENT))
      return data.turns.slice(start, start + RECENT).map((turn, i) => turnRow(data, turn, start + i))
    }

    const mapKeys = () => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="prev" plain dimColor hotkey="k" label="前" onPress={() => void movePick($, -1)} />
        <Button key="next" plain dimColor hotkey="j" label="次" onPress={() => void movePick($, 1)} />
        <Button key="jump" plain dimColor hotkey="g" label="飛ぶ" onPress={() => void jump($, at)} />
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
        {map && <Text dimColor>{fit(`─ セッション · ${lengthOf(now - map.startedAt)}`, width)}</Text>}
        {map && map.turns.length > 0 && strip(map)}
        {map && map.turns.length > 0 && legend()}
        {map && map.percent !== undefined && gauge(map.percent)}
        {map && map.turns.length > 0 && shownTurns(map)}
        {map && map.turns.length > 0 && mapKeys()}
        {asked !== '' && <Text bold>{fit(asked, width)}</Text>}
        <Text dimColor>{`─ 計画${plan.length > 0 ? ` ${doneCount}/${plan.length}` : ''}`}</Text>
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
