import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TaskStatus, WnFile, WnTask } from '../types'

type Engine = EngineInterface

const PANE = 'where-now'
const TITLE = '今どこ'
const COMMAND = 'where'
const FILE_LIMIT = 200

// 形を変えたら shape の札を変える: 前の版が残した値を読まずに初期値から始める
const ask = atom({ plugin: 'where-now', key: 'ask' } as const, '')
const tasks = atom({ plugin: 'where-now', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const files = atom({ plugin: 'where-now', key: 'files' } as const, [], { shape: 'files-1' })

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

// ---- フック ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '計画 todo と、このターンで読んだ・書いたファイルをペインに出す',
    })
    // 頼まれずに開くペインは幅が足りるまで待つ。/where なら狭くても開く
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return {}
  })

  // 人の依頼で切り替える。サブエージェントの開始と、文の無い続きでは消さない
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      await update($, ask, () => e.text)
      await update($, files, () => [])
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // 中断で終わりを聞けなかった呼び出しを、動いたままにしない
    if (e.agentId === undefined) {
      await update($, files, list => list.map(file => ({ ...file, running: 0 })))
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const asked = await read($, ask)
    const plan = await read($, tasks)
    const touched = await read($, files)
    const root = await rootOf($)
    const width = Math.max(16, e.props.bodyColumns)

    const doneCount = plan.filter(task => task.status === 'completed').length
    const readCount = touched.filter(file => file.reads > 0 && file.writes === 0).length
    const writeCount = touched.filter(file => file.writes > 0).length

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
        {asked !== '' && <Text bold>{fit(asked, width)}</Text>}
        <Text dimColor>{`─ 計画${plan.length > 0 ? ` ${doneCount}/${plan.length}` : ''}`}</Text>
        {plan.length === 0 && <Text dimColor>計画はありません</Text>}
        {plan.map(taskRow)}
        <Text dimColor>{`─ このターン · 読 ${readCount} · 書 ${writeCount}`}</Text>
        {touched.length === 0 && <Text dimColor>まだ触っていません</Text>}
        {touched.map(fileRow)}
      </Box>
    )
  })
}
