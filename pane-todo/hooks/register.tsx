import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Todo, TodoList, TodoTab } from '../types'
import { addedId, cells, draftOf, dueOf, fit, padTo, parseTasks } from './tasks'

type Engine = EngineInterface

const PANE = 'pane-todo'
const TITLE = 'Todo'
const COMMAND = 'todo'
const SERVER = 'pane'
const LIMIT = 100
const EVERY_MS = 60_000
const WANTED_ROWS = 20
/** メモを何行まで見せるか */
const NOTE_LINES = 4
/** s の 2 回目をこの間に押すと送る */
const SEND_ARM_MS = 3000

const TABS: readonly { tab: TodoTab; label: string; hotkey: string }[] = [
  { tab: 'today', label: '今日', hotkey: '1' },
  { tab: 'active', label: 'すべて', hotkey: '2' },
  { tab: 'focus', label: '重要', hotkey: '3' },
  { tab: 'ideas', label: '思いつき', hotkey: '4' },
]

const tabNow = atom({ plugin: 'pane-todo', key: 'tab' } as const, 'today')
// 形を変えたら shape の札を変える: 前の版が残した値を読まずに初期値から始める
const list = atom({ plugin: 'pane-todo', key: 'list' } as const, null, { shape: 'list-1' })
const isLoading = atom({ plugin: 'pane-todo', key: 'isLoading' } as const, false)
const selected = atom({ plugin: 'pane-todo', key: 'selected' } as const, null)
const composing = atom({ plugin: 'pane-todo', key: 'composing' } as const, false)
const showNotes = atom({ plugin: 'pane-todo', key: 'showNotes' } as const, false)
const lastDone = atom({ plugin: 'pane-todo', key: 'lastDone' } as const, null)

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const rowKey = (todo: Todo): string => `task:${todo.id}`

/** Pane の MCP を呼ぶ。失敗は投げる */
async function callPane($: Engine, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await $.mcp.call(SERVER, tool, args)
  const text = result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
  if (result.isError) throw new Error(text || `${tool} が失敗しました`)
  return text
}

let inFlight: Promise<void> | undefined

async function load($: Engine): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    await update($, isLoading, () => true)
    try {
      const tab = await read($, tabNow)
      const { tasks, count } = parseTasks(await callPane($, 'list_tasks', { tab, limit: LIMIT }))
      const loadedAt = await $.clock.now()
      await update($, list, () => ({ tasks, count, loadedAt }))
      await update($, selected, id => (tasks.some(todo => todo.id === id) ? id : (tasks[0]?.id ?? null)))
    } catch (err) {
      const loadedAt = await $.clock.now()
      const error = message(err)
      await update($, list, prev => (prev ? { ...prev, error } : { tasks: [], count: 0, loadedAt, error }))
    } finally {
      await update($, isLoading, () => false)
      inFlight = undefined
    }
  })()
  return inFlight
}

async function picked($: Engine): Promise<Todo | undefined> {
  const id = await read($, selected)
  return (await read($, list))?.tasks.find(todo => todo.id === id)
}

/** 帯も一緒に動かす。全部の行を描くので、並びはずれない */
async function select($: Engine, todo: Todo): Promise<void> {
  await update($, selected, () => todo.id)
  await $.ui.focus({ requestId: PANE, key: rowKey(todo) }).catch(() => undefined)
  await $.ui.scroll({ in: PANE, to: { key: rowKey(todo) } }).catch(() => undefined)
}

/** j / k を順に動かす。並んで走ると、押した数だけ進まない */
let moves: Promise<void> = Promise.resolve()

const queueMove = ($: Engine, by: number): void => {
  moves = moves
    .then(async () => {
      const tasks = (await read($, list))?.tasks ?? []
      const id = await read($, selected)
      const at = tasks.findIndex(todo => todo.id === id)
      const next = tasks[Math.min(tasks.length - 1, Math.max(0, at + by))]
      if (next) await select($, next)
    })
    .catch(() => undefined)
}

/**
 * 読み終えたら帯を選んでいる行へ。読み込みは開いたあとに終わるので、先に帯がタブに乗り、
 * そのままだと Enter がタブを押してしまう
 */
async function loadAndFocus($: Engine): Promise<void> {
  await load($)
  const todo = await picked($)
  if (todo) await select($, todo)
}

async function changeTab($: Engine, tab: TodoTab): Promise<void> {
  await update($, tabNow, () => tab)
  await update($, list, () => null)
  await update($, selected, () => null)
  await loadAndFocus($)
}

async function complete($: Engine): Promise<void> {
  const todo = await picked($)
  if (!todo) return
  try {
    const tasks = (await read($, list))?.tasks ?? []
    const at = tasks.indexOf(todo)
    await callPane($, 'complete_task', { id: todo.id })
    await update($, lastDone, () => todo.id)
    const next = tasks[at + 1] ?? tasks[at - 1]
    await update($, selected, () => next?.id ?? null)
    $.ui.toast(`完了: ${todo.title} (u で戻す)`)
    await load($)
    if (next) await select($, next)
  } catch (err) {
    $.ui.toast(`完了にできませんでした: ${message(err)}`)
  }
}

async function undoDone($: Engine): Promise<void> {
  const id = await read($, lastDone)
  if (!id) {
    $.ui.toast('戻せる Todo がありません')
    return
  }
  try {
    await callPane($, 'complete_task', { id, completed: false })
    await update($, lastDone, () => null)
    await update($, selected, () => id)
    await load($)
  } catch (err) {
    $.ui.toast(`戻せませんでした: ${message(err)}`)
  }
}

/** 入力欄の autoFocus は帯のある行からキーを奪わないので、明示して移す */
async function toggleCompose($: Engine): Promise<void> {
  const open = !(await read($, composing))
  await update($, composing, () => open)
  if (!open) return
  const target = { requestId: PANE, key: 'new-todo' }
  await $.ui.focus(target).catch(() => undefined)
  $.clock.after(66, () => void $.ui.focus(target).catch(() => undefined))
}

async function addTodo($: Engine, text: string): Promise<void> {
  const title = text.trim()
  await update($, composing, () => false)
  if (!title) return
  try {
    const id = addedId(await callPane($, 'add_task', { title }))
    const isAdded = (todo: Todo) => (id ? todo.id === id : todo.title === title)
    await load($)
    // 期限の無い Todo は「今日」に出ない。保存できたのに見えないので、出ている面へ移る
    let found = (await read($, list))?.tasks.find(isAdded)
    if (!found && (await read($, tabNow)) !== 'active') {
      await changeTab($, 'active')
      found = (await read($, list))?.tasks.find(isAdded)
      $.ui.toast(`追加しました: ${title} (期限が無いので「すべて」に出ています)`)
    } else {
      $.ui.toast(`追加しました: ${title}`)
    }
    if (found) await select($, found)
  } catch (err) {
    $.ui.toast(`追加できませんでした: ${message(err)}`)
  }
}

/** Enter: 下書きにして、キーをプロンプトへ返す。送るかどうかは人が決める */
async function sendToPrompt($: Engine, todo: Todo): Promise<void> {
  const filled = await $.prompt.fill({ text: draftOf(todo), mode: 'insert' }).catch(() => undefined)
  if (!filled?.isFilled) {
    $.ui.toast('プロンプトへ入れられませんでした')
    return
  }
  await closePane($)
}

/** s の 1 回目で選んだ Todo。読み直しで消えても、押し直すだけで済む */
let armed: { id: string; at: number } | undefined

/**
 * s: Claude へそのまま送る。送ると作業が始まるので、押し間違いで走らないよう 2 回押す。
 * Todo は完了にしない
 */
async function sendNow($: Engine): Promise<void> {
  const todo = await picked($)
  if (!todo) return
  const now = await $.clock.now()
  if (armed?.id !== todo.id || now - armed.at > SEND_ARM_MS) {
    armed = { id: todo.id, at: now }
    $.ui.toast(`もう一度 s で Claude へ送ります: ${fit(todo.title, 40)}`)
    return
  }
  armed = undefined
  await closePane($).catch(() => undefined)
  try {
    await $.prompt.submit({ text: draftOf(todo), asUser: true })
  } catch (err) {
    $.ui.toast(`送れませんでした: ${message(err)}`)
  }
}

async function openUrl($: Engine): Promise<void> {
  const todo = await picked($)
  if (!todo?.url) {
    $.ui.toast('この Todo にはリンクがありません')
    return
  }
  const ran = await $.process.run(['open', todo.url], { timeoutMs: 10000 }).catch(() => undefined)
  if (ran?.exitCode !== 0) $.ui.toast(`開けませんでした: ${todo.url}`)
}

async function closePane($: Engine): Promise<void> {
  await $.ui.close({ id: PANE })
}

async function isShown($: Engine): Promise<{ isOpen: boolean; isFocused: boolean }> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  return { isOpen: pane?.isPlaced === true, isFocused: pane?.isFocused === true }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Pane の Todo を開いてキーを渡す。キーがあれば閉じる' })
    $.clock.every(EVERY_MS, () => {
      void isShown($).then(({ isOpen }) => (isOpen ? load($) : undefined))
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const { isOpen, isFocused } = await isShown($)
    if (isOpen && isFocused) {
      await closePane($)
      return {}
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: WANTED_ROWS })
    void loadAndFocus($)
    return {}
  })

  // Claude が Todo を触ったかもしれないので、開いていれば読み直す
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await isShown($).catch(() => undefined))?.isOpen) void load($)
    return done
  })

  // 矢印・Tab・クリックで帯が動いたら、選択も合わせる
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const done = await next(e)
    const id = /^task:(.+)$/.exec(e.element ?? '')?.[1]
    if (id !== undefined) await update($, selected, () => id)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : undefined

    const tab = await read($, tabNow)
    const data: TodoList | null = await read($, list)
    const loading = await read($, isLoading)
    const chosen = await read($, selected)
    const isComposing = await read($, composing)
    const notesOn = await read($, showNotes)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const tasks = data?.tasks ?? []
    const overCount = tasks.filter(todo => dueOf(todo.due, now)?.level === 'over').length

    const row = (todo: Todo) => {
      const isHere = todo.id === chosen
      const due = dueOf(todo.due, now)
      const tail = due ? ` ${due.label}` : ''
      const room = Math.max(6, width - 2 - cells(tail))
      const color = due?.level === 'over' ? 'error' : due?.level === 'today' ? 'warning' : undefined
      return (
        <Box key={`item:${todo.id}`} flexDirection="column">
          <Button
            key={rowKey(todo)}
            plain
            {...(isHere ? { autoFocus: true as const } : {})}
            onPress={() => void sendToPrompt($, todo)}
          >
            <Text color="claude" bold={isHere}>{isHere ? '› ' : '  '}</Text>
            <Text bold={isHere}>{padTo(fit(todo.title, room), room)}</Text>
            <Text {...(color ? { color } : { dimColor: true })}>{tail}</Text>
          </Button>
          {isHere && notesOn && (
            <Box flexDirection="column" paddingLeft={2}>
              {todo.source && <Text dimColor>{todo.source}</Text>}
              {(todo.notes ?? 'メモはありません')
                .split('\n')
                .slice(0, NOTE_LINES)
                .map(line => (
                  <Text dimColor>{fit(line, width - 2)}</Text>
                ))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold color="claude">◆ Todo</Text>
          {data && <Text bold>{String(data.count)}<Text dimColor> 件</Text></Text>}
          {overCount > 0 && <Text color="error">{`期限切れ ${overCount}`}</Text>}
          {loading && <Text dimColor>更新中…</Text>}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {TABS.map(one => (
            <Button
              key={`tab:${one.tab}`}
              plain
              dimColor={one.tab !== tab}
              hotkey={one.hotkey}
              label={one.label}
              onPress={() => void changeTab($, one.tab)}
            />
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="next" plain dimColor hotkey="j" label="次" onPress={() => queueMove($, 1)} />
          <Button key="prev" plain dimColor hotkey="k" label="前" onPress={() => queueMove($, -1)} />
          <Button key="done" plain dimColor hotkey="x" label="完了" onPress={() => void complete($)} />
          <Button key="undo" plain dimColor hotkey="u" label="戻す" onPress={() => void undoDone($)} />
          {Input && (
            <Button
              key="add"
              plain
              dimColor
              hotkey="a"
              label="追加"
              onPress={() => void toggleCompose($)}
            />
          )}
          <Button key="notes" plain dimColor hotkey="d" label="メモ" onPress={() => void update($, showNotes, value => !value)} />
          <Button key="open" plain dimColor hotkey="o" label="開く" onPress={() => void openUrl($)} />
          <Button key="refresh" plain dimColor hotkey="r" label="更新" onPress={() => void load($)} />
          <Button key="close" plain dimColor hotkey="q" label="閉じる" onPress={() => void closePane($)} />
          <Button key="send" plain dimColor hotkey="s" label="すぐ送る (2回)" onPress={() => void sendNow($)} />
          <Text dimColor>Enter: 下書き</Text>
        </Box>
        {isComposing && Input && (
          <Input
            key="new-todo"
            label="追加 "
            placeholder="明日 17時 のように書くと期限になる"
            submitLabel="追加"
            autoFocus
            onSubmit={value => void addTodo($, value)}
          />
        )}
        {data?.error && <Text color="error">{fit(data.error, width * 2)}</Text>}
        {data && !data.error && tasks.length === 0 && <Text dimColor>Todo はありません</Text>}
        {!data && <Text dimColor>読み込み中…</Text>}
        {tasks.map(row)}
      </Box>
    )
  })
}
