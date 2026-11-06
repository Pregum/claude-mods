import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { CalEvent } from '../types'

const PANE = 'calendar-peek'
const SERVER = 'claude.ai Google Calendar'
const FETCH_DAYS = 7
const VIEWS = [
  { days: 1, label: '1日' },
  { days: 3, label: '3日' },
  { days: 7, label: '1週間' },
]
const DEFAULT_VIEW = { days: 3, label: '3日' }
const MIN_GAP_MINUTES = 15
const KEY_HELP = [
  ['t', '1日 / 3日 / 1週間を切り替え'],
  ['j k', '予定を上下に移動'],
  ['↑ ↓', 'ボタンを順にたどる'],
  ['Enter', '選んでいる予定の会議を開く'],
  ['o', '進行中か次の会議を開く'],
  ['q Esc', 'ペインを閉じる'],
  ['h', 'このキー一覧を閉じる'],
]
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const REFRESH_MINUTES = 5
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

const events = atom({ plugin: 'calendar-peek', key: 'events' } as const, [], {
  shape: 'events-2',
})
const viewDays = atom({ plugin: 'calendar-peek', key: 'days' } as const, 3)
const cursor = atom({ plugin: 'calendar-peek', key: 'cursor' } as const, '')
const isHelpOpen = atom(
  { plugin: 'calendar-peek', key: 'isHelpOpen' } as const,
  false,
)
const nowMs = atom({ plugin: 'calendar-peek', key: 'now' } as const, 0)
const fetchedAt = atom({ plugin: 'calendar-peek', key: 'fetchedAt' } as const, 0)
const lastError = atom({ plugin: 'calendar-peek', key: 'error' } as const, '')

type Host = Parameters<Hook<'session.start'>>[0]

const pad = (n: number) => String(n).padStart(2, '0')

const dateKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const clockText = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const dayLabel = (key: string, today: string) => {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const label = `${m}/${d}(${WEEKDAYS[date.getDay()]})`
  return key === today ? `今日 ${label}` : label
}

const eventDay = (event: CalEvent) => event.start.slice(0, 10)

const isOver = (event: CalEvent, now: number) =>
  event.isAllDay
    ? event.end <= dateKey(now)
    : Date.parse(event.end) <= now

/**
 * 会議の URL を探す。招待の本文は他人が書けるので、https の会議サービスだけを通す。
 * ホストの直後は / か末尾に限るので、`https://zoom.us@example.com` のような形は弾く。
 */
const MEETING_URL =
  /^https:\/\/((?:[a-z0-9-]+\.)*zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)(?:\/[^\s]*)?$/i

const findMeetingUrl = (texts: (string | undefined)[]) => {
  for (const text of texts) {
    const urls = text?.replaceAll('&amp;', '&').match(/https:\/\/[^\s"'<>]+/g) ?? []
    const url = urls.find(one => MEETING_URL.test(one))
    if (url) return url
  }
  return undefined
}

const meetingLabel = (url: string) =>
  url.includes('zoom.us') ? 'Zoom' : url.includes('teams.') ? 'Teams' : 'Meet'

/** Calendar の応答から、表示する予定だけを取り出す。 */
const parseEvents = (text: string): CalEvent[] => {
  const body = JSON.parse(text) as {
    events?: {
      id: string
      summary?: string
      status?: string
      start?: { date?: string; dateTime?: string }
      end?: { date?: string; dateTime?: string }
      attendees?: { self?: boolean; responseStatus?: string }[]
      conferenceUrl?: string
      conferenceData?: { videoEntryPoint?: { uri?: string } }
      location?: string
      description?: string
    }[]
  }

  return (body.events ?? []).flatMap(raw => {
    const declined = raw.attendees?.some(
      one => one.self && one.responseStatus === 'declined',
    )
    const start = raw.start?.dateTime ?? raw.start?.date
    const end = raw.end?.dateTime ?? raw.end?.date
    if (declined || raw.status === 'cancelled' || !start || !end) return []

    const url = findMeetingUrl([
      raw.conferenceUrl,
      raw.conferenceData?.videoEntryPoint?.uri,
      raw.location,
      raw.description,
    ])

    return [
      {
        ...(url ? { url } : {}),
        id: raw.id,
        title: raw.summary ?? '（タイトルなし）',
        start,
        end,
        isAllDay: !raw.start?.dateTime,
      },
    ]
  })
}

const nextLine = (list: CalEvent[], now: number) => {
  const event = list
    .filter(one => !one.isAllDay && !isOver(one, now))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0]
  if (!event) return undefined

  const start = Date.parse(event.start)
  if (start <= now) return `📅 進行中: ${event.title}`

  const minutes = Math.ceil((start - now) / MINUTE)
  const until =
    minutes < 60
      ? `あと${minutes}分`
      : dateKey(start) === dateKey(now)
        ? `あと${Math.floor(minutes / 60)}時間${minutes % 60}分`
        : dayLabel(dateKey(start), '')

  return `📅 次: ${clockText(start)} ${event.title}（${until}）`
}


const refresh = async ($: Host) => {
  const now = await $.clock.now()

  try {
    const result = await $.mcp.call(SERVER, 'list_events', {
      startTime: `${dateKey(now)}T00:00:00`,
      endTime: `${dateKey(now + FETCH_DAYS * DAY)}T00:00:00`,
      orderBy: 'startTime',
      pageSize: 100,
    })
    const block = result.content.find((one: { type: string }) => one.type === 'text')
    const text = block && 'text' in block ? String(block.text) : ''
    if (result.isError) throw new Error(text || 'isError')

    const list = parseEvents(text)
    await update($, events, () => list)
    await update($, fetchedAt, () => now)
    await update($, lastError, () => '')
    await update($, nowMs, () => now)
    $.ui.status(nextLine(list, now))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, lastError, () => message.slice(0, 120))
  }
}

const tick = async ($: Host) => {
  const now = await $.clock.now()
  await update($, nowMs, () => now)

  const failed = (await read($, lastError)) !== ''
  const age = now - (await read($, fetchedAt))
  if (failed || age >= REFRESH_MINUTES * MINUTE) {
    await refresh($)
    return
  }
  $.ui.status(nextLine(await read($, events), now))
}

type Row =
  | { kind: 'day' | 'now' | 'gap'; key: string; text: string }
  | {
      kind: 'event'
      key: string
      text: string
      state?: 'past' | 'running' | 'next'
      event: CalEvent
    }

const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}分`
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`
}

/** 日ごとのタイムライン。今日には現在時刻の行を入れ、1日表示では空き時間も出す。 */
const buildRows = (list: CalEvent[], now: number, days: number): Row[] => {
  const today = dateKey(now)
  const nextId = list.find(
    one => !one.isAllDay && Date.parse(one.start) > now,
  )?.id
  const rows: Row[] = []

  for (let offset = 0; offset < days; offset += 1) {
    const key = dateKey(now + offset * DAY)
    const isToday = key === today
    const onDay = list.filter(one => {
      const day = eventDay(one) < today ? today : eventDay(one)
      return day === key && (days === 1 || !isOver(one, now))
    })
    if (!isToday && onDay.length === 0) continue

    rows.push({ kind: 'day', key: `day:${key}`, text: dayLabel(key, today) })

    for (const event of onDay.filter(one => one.isAllDay)) {
      rows.push({
        kind: 'event',
        key: event.id,
        text: `終日 ${event.title}`,
        event,
      })
    }

    let isNowPlaced = !isToday
    let busyUntil = 0
    const placeNow = () => {
      rows.push({ kind: 'now', key: 'now', text: `── ${clockText(now)} いま ──` })
      isNowPlaced = true
    }

    for (const event of onDay.filter(one => !one.isAllDay)) {
      const start = Date.parse(event.start)
      const end = Date.parse(event.end)
      if (!isNowPlaced && start > now) placeNow()

      if (days === 1 && isNowPlaced) {
        const free = Math.floor((start - Math.max(busyUntil, now)) / MINUTE)
        if (free >= MIN_GAP_MINUTES) {
          rows.push({
            kind: 'gap',
            key: `gap:${event.id}`,
            text: `　　空き ${duration(free)}`,
          })
        }
      }

      const isRunning = start <= now && end > now
      const rest = Math.ceil((end - now) / MINUTE)
      rows.push({
        kind: 'event',
        key: event.id,
        text:
          `${clockText(start)}-${clockText(end)} ${event.title}` +
          (isRunning ? `（残り${duration(rest)}）` : ''),
        state: end <= now
          ? 'past'
          : isRunning
            ? 'running'
            : event.id === nextId
              ? 'next'
              : undefined,
        event,
      })
      busyUntil = Math.max(busyUntil, end)
    }

    if (!isNowPlaced) placeNow()
  }

  return rows
}

const rowKey = (event: CalEvent) => `row:${event.id}`

const eventRows = (rows: Row[]) =>
  rows.flatMap(row => (row.kind === 'event' ? [row] : []))

/** 既定の位置: 進行中か次の会議、なければ最初の終わっていない予定。 */
const homeRow = (rows: Row[], meeting: CalEvent | undefined) => {
  const list = eventRows(rows)
  return (
    list.find(row => row.event.id === meeting?.id) ??
    list.find(row => row.state !== 'past') ??
    list[0]
  )
}

const findMeeting = (list: CalEvent[], now: number) =>
  list.find(one => one.url && !one.isAllDay && Date.parse(one.end) > now)

/** 移動先の行。まだどこにもいなければ既定の行に合わせ、端では止まる。 */
export const pickRow = (
  keys: string[],
  current: string,
  home: string | undefined,
  by: number,
) => {
  const at = keys.indexOf(current)
  if (at < 0) return home ?? keys[0]

  return keys[Math.min(keys.length - 1, Math.max(0, at + by))]
}

/** スクロールは見やすくするためだけなので、失敗しても操作は止めない。 */
const reveal = async ($: Host, key: string, block: 'center' | 'nearest') => {
  try {
    await $.ui.scroll({ to: { key }, in: PANE, block })
  } catch {
    // 描画がまだない場合など
  }
}

const moveCursor = async ($: Host, rows: Row[], home: Row | undefined, by: number) => {
  const keys = eventRows(rows).map(row => rowKey(row.event))
  const homeKey = home?.kind === 'event' ? rowKey(home.event) : undefined
  const target = pickRow(keys, await read($, cursor), homeKey, by)
  if (!target) return

  await $.ui.focus({ requestId: PANE, key: target })
  await reveal($, target, 'nearest')
}

const openMeeting = async ($: Host, event: CalEvent) => {
  if (!event.url) {
    $.ui.toast(`会議の URL はありません: ${event.title}`)
    return
  }

  try {
    const { exitCode } = await $.process.run(['open', event.url])
    if (exitCode !== 0) throw new Error(`exit ${exitCode}`)
    $.ui.toast(`${meetingLabel(event.url)} を開きました: ${event.title}`)
  } catch {
    $.ui.toast(`開けませんでした: ${event.url}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'calendar',
      description: '直近の予定をペインで開き、最新の内容に更新する',
    })

    void refresh($)
    void $.ui.open({ id: PANE, title: '予定' })
    $.clock.every(MINUTE, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'calendar' }, async $ => {
    await $.ui.open({
      id: PANE,
      title: '予定',
      focus: true,
      closeOnEscape: true,
    })
    await refresh($)
    const error = await read($, lastError)

    // 開いた時点で、これからの予定が見える位置にする。
    const now = await read($, nowMs)
    const list = await read($, events)
    const rows = buildRows(list, now, await read($, viewDays))
    const home = homeRow(rows, findMeeting(list, now))
    if (home?.kind === 'event') await reveal($, rowKey(home.event), 'center')

    return {
      text: error ? `予定を取得できませんでした: ${error}` : '予定を更新しました。',
    }
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.element?.startsWith('row:')) await update($, cursor, () => e.element ?? '')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, events)
    const days = await read($, viewDays)
    const showHelp = await read($, isHelpOpen)
    const stamp = await read($, fetchedAt)
    const error = await read($, lastError)
    const now = (await read($, nowMs)) || (await $.clock.now())

    const meeting = findMeeting(list, now)
    const rows = buildRows(list, now, days)
    const home = homeRow(rows, meeting)
    const viewAt = Math.max(0, VIEWS.findIndex(one => one.days === days))
    const view = VIEWS[viewAt] ?? DEFAULT_VIEW
    const nextView = VIEWS[(viewAt + 1) % VIEWS.length] ?? DEFAULT_VIEW

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Button
            key="toggle-view"
            label={`表示: ${view.label}`}
            plain
            hotkey="t"
            onPress={() => update($, viewDays, () => nextView.days)}
          />
          <Button
            key="close"
            label="閉じる"
            plain
            hotkey="q"
            dimColor
            onPress={() => $.ui.close({ id: PANE })}
          />
          <Button
            key="help"
            label="キー一覧"
            plain
            hotkey="h"
            dimColor
            onPress={() => update($, isHelpOpen, open => !open)}
          />
        </Box>
        {showHelp && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {KEY_HELP.map(([keys, action]) => (
              <Text>
                <Text bold>{(keys ?? '').padEnd(6)}</Text> {action}
              </Text>
            ))}
          </Box>
        )}
        {stamp === 0 && !error && <Text dimColor>読み込み中…</Text>}
        {stamp !== 0 &&
          rows.map(row => {
            if (row.kind === 'day') return <Text bold>{row.text}</Text>
            if (row.kind === 'now') {
              return (
                <Text bold color="yellow">
                  {row.text}
                </Text>
              )
            }
            if (row.kind !== 'event') return <Text dimColor>{row.text}</Text>

            const style = {
              bold: row.state === 'running' || row.state === 'next',
              color: row.state === 'running' ? 'green' : undefined,
              dimColor: row.state === 'past',
            }
            const { event } = row

            return (
              <Button
                key={rowKey(event)}
                label={`${row.text} を開く`}
                plain
                autoFocus={home === row ? true : undefined}
                onPress={() => openMeeting($, event)}
              >
                <Text {...style}>{row.text}</Text>
                {event.url && <Text dimColor> {meetingLabel(event.url)}</Text>}
              </Button>
            )
          })}
        {meeting?.url && (
          <Button
            key="join-next"
            plain
            hotkey="o"
            label={`${meetingLabel(meeting.url)} を開く: ${meeting.title}`}
            onPress={() => openMeeting($, meeting)}
          />
        )}
        <Box flexDirection="row" gap={2}>
          <Button
            key="move-down"
            label="下へ"
            plain
            hotkey="j"
            dimColor
            onPress={() => moveCursor($, rows, home, 1)}
          />
          <Button
            key="move-up"
            label="上へ"
            plain
            hotkey="k"
            dimColor
            onPress={() => moveCursor($, rows, home, -1)}
          />
        </Box>
        {error && <Text color="red">取得エラー: {error}</Text>}
        {stamp !== 0 && (
          <Text dimColor>{clockText(stamp)} 更新</Text>
        )}
      </Box>
    )
  })
}
