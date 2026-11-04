import type { Todo } from '../types'

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** list_tasks の答え (JSON の文字列) を読む。形が違えば投げる */
export const parseTasks = (text: string): { tasks: Todo[]; count: number } => {
  const root = asObject(JSON.parse(text))
  if (!root || !Array.isArray(root.tasks)) throw new Error('Pane の答えの形が違います')
  const tasks = root.tasks.flatMap((raw): Todo[] => {
    const row = asObject(raw)
    const id = asString(row?.id)
    const title = asString(row?.title)
    if (!id || !title) return []
    const source = asString(row?.source)
    const notes = asString(row?.notes)
    const due = asString(row?.due)
    const url = asString(row?.url)
    return [
      {
        id,
        title,
        ...(source ? { source } : {}),
        ...(notes ? { notes } : {}),
        ...(due ? { due } : {}),
        ...(url ? { url } : {}),
      },
    ]
  })
  return { tasks, count: typeof root.count === 'number' ? root.count : tasks.length }
}

/** add_task の答えから id を拾う。形が決まっていないので読めなければ undefined */
export const addedId = (text: string): string | undefined => {
  try {
    const root = asObject(JSON.parse(text))
    return asString(root?.id) ?? asString(asObject(root?.task)?.id)
  } catch {
    return undefined
  }
}

export type DueLevel = 'over' | 'today' | 'later'

const dayOf = (at: number): number => {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 時刻の無い期限は 00:00:00.000 で来る。その日いっぱいは期限切れにしない */
const isAllDay = (due: string): boolean => /T00:00:00(\.0+)?$/.test(due)

export const dueOf = (due: string | undefined, now: number): { label: string; level: DueLevel } | undefined => {
  if (!due) return undefined
  const at = Date.parse(due)
  if (Number.isNaN(at)) return undefined
  const date = new Date(at)
  const day = dayOf(at)
  const today = dayOf(now)
  const hasTime = !isAllDay(due)
  const clock = hasTime ? ` ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}` : ''
  const label = `${date.getMonth() + 1}/${date.getDate()}${clock}`
  if (day < today || (hasTime && at < now)) return { label, level: 'over' }
  if (day === today) return { label: `今日${clock}`, level: 'today' }
  return { label, level: 'later' }
}

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

export const cells = (text: string): number => [...text].reduce((n, ch) => n + widthOf(ch), 0)

export const fit = (text: string, room: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (cells(flat) <= room) return flat
  let out = ''
  let used = 0
  for (const ch of flat) {
    if (used + widthOf(ch) > room - 1) break
    out += ch
    used += widthOf(ch)
  }
  return `${out}…`
}

export const padTo = (text: string, room: number): string =>
  `${text}${' '.repeat(Math.max(0, room - cells(text)))}`

/** プロンプトへ渡す下書き。送るかどうかは人が決める */
export const draftOf = (todo: Todo): string =>
  todo.notes ? `Todo: ${todo.title}\n\n${todo.notes}` : `Todo: ${todo.title}`
