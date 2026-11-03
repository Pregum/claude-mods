import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { WsSession } from '../types'
import { collect, commandFor, copyText, peek } from './collect'

type Engine = EngineInterface

const PANE = 'workspace-sessions'
const COMMAND = 'ws'
/** ペインが開いている間、一覧を描き直す間隔 */
const EVERY_MS = 20_000
/** 「過去」を畳んでいるときに見せる件数 */
const PAST_FOLDED = 5

// 形を変えたら shape の札を変える: 前の版が残した値を読まずに初期値から始める
const snapshot = atom({ plugin: 'workspace-sessions', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const isLoading = atom({ plugin: 'workspace-sessions', key: 'isLoading' } as const, false)
const selected = atom({ plugin: 'workspace-sessions', key: 'selected' } as const, null)
const peeked = atom({ plugin: 'workspace-sessions', key: 'peek' } as const, null, {
  shape: 'peek-1',
})
const showAll = atom({ plugin: 'workspace-sessions', key: 'showAll' } as const, false)
const sent = atom({ plugin: 'workspace-sessions', key: 'sent' } as const, 0)

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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

const cells = (text: string): number => {
  let n = 0
  for (const ch of text) n += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return n
}

const fit = (text: string, room: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (cells(flat) <= room) return flat
  let out = ''
  let used = 0
  for (const ch of flat) {
    const w = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > room - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

// ---- 表示の言葉 ----

const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'いま'
  if (s < 3600) return `${Math.floor(s / 60)}分前`
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}日前`
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const stateLabel = (s: WsSession): string => {
  if (s.kind === 'past') return ''
  if (s.isRunning && s.status === 'busy') return '作業中'
  if (s.state === 'blocked') return '入力待ち'
  if (s.state === 'done') return s.isRunning ? '完了' : '完了・停止'
  if (s.state === 'working') return s.isRunning ? '作業中' : '停止'
  return s.isRunning ? '待機' : '停止'
}

const kindLabel = (s: WsSession): string =>
  s.kind === 'background' ? 'bg' : s.kind === 'interactive' ? '端末' : ''

const dotOf = (s: WsSession): { glyph: string; color?: string } => {
  if (s.isSelf) return { glyph: '◆', color: 'claude' }
  if (s.isRunning && s.status === 'busy') return { glyph: '●', color: 'warning' }
  if (s.state === 'blocked') return { glyph: '!', color: 'error' }
  if (s.isRunning) return { glyph: '●', color: 'success' }
  return { glyph: '○' }
}

const metaOf = (s: WsSession, now: number): string =>
  [s.isSelf ? 'ここ' : '', kindLabel(s), stateLabel(s), s.place, ago(s.at, now)]
    .filter(Boolean)
    .join(' · ')

// ---- 動き ----

let inFlight: Promise<void> | undefined

async function refresh($: Engine): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    await update($, isLoading, () => true)
    try {
      const next = await collect($)
      await update($, snapshot, () => next)
    } catch (err) {
      const loadedAt = await $.clock.now()
      await update($, snapshot, prev =>
        prev
          ? { ...prev, error: message(err) }
          : { root: '', label: '', sessions: [], loadedAt, error: message(err) },
      )
    } finally {
      await update($, isLoading, () => false)
      inFlight = undefined
    }
  })()
  return inFlight
}

async function isPaneOpen($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    return false
  }
}

async function choose($: Engine, s: WsSession): Promise<void> {
  if ((await read($, selected)) === s.sessionId) {
    await update($, selected, () => null)
    return
  }
  await update($, selected, () => s.sessionId)
  await update($, peeked, () => ({ sessionId: s.sessionId, isLoading: true }))
  const seen = await peek($, s)
  await update($, peeked, cur => (cur?.sessionId === s.sessionId ? seen : cur))
}

async function copyCommand($: Engine, s: WsSession, surface: RenderSurface): Promise<void> {
  const command = commandFor(s)
  if (!command) {
    $.ui.toast('このセッションは別の端末で動いています。送る欄か Web から触れます')
    return
  }
  const text = copyText(s, command)
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `コピーしました: ${text}` : `コピーできませんでした (${copied.reason}): ${text}`)
}

async function openWeb($: Engine, s: WsSession): Promise<void> {
  if (!s.webUrl) {
    $.ui.toast('Web のリンクがありません (Remote Control が切れています)')
    return
  }
  try {
    const ran = await $.process.run(['open', s.webUrl], { timeoutMs: 10000 })
    if (ran.exitCode === 0) return
  } catch {
    // 下で知らせる
  }
  $.ui.toast(`ブラウザを開けませんでした: ${s.webUrl}`)
}

async function cmuxBin($: Engine): Promise<string | undefined> {
  const bundled = await $.env.get('CMUX_BUNDLED_CLI_PATH')
  if (bundled) return bundled
  return (await $.env.get('CMUX_SOCKET_PATH')) ? 'cmux' : undefined
}

async function openSession($: Engine, s: WsSession, surface: RenderSurface): Promise<void> {
  if (s.isSelf) {
    $.ui.toast('いま見ているセッションです')
    return
  }
  const command = commandFor(s)
  if (!command) {
    await openWeb($, s)
    return
  }
  const cmux = await cmuxBin($)
  if (cmux) {
    try {
      const cwd = (await $.fs.exists(s.cwd)) ? s.cwd : undefined
      const ran = await $.process.run(
        [
          cmux,
          'new-workspace',
          '--name',
          s.name.slice(0, 60),
          ...(cwd ? ['--cwd', cwd] : []),
          '--command',
          cwd ? command : copyText(s, command),
          '--focus',
          'true',
        ],
        { timeoutMs: 15000 },
      )
      if (ran.exitCode === 0) {
        $.ui.toast(`cmux の新しいワークスペースで開きました: ${s.name}`)
        return
      }
    } catch {
      // cmux が動いていない: コピーに回す
    }
  }
  await copyCommand($, s, surface)
}

async function sendTo($: Engine, s: WsSession, text: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  const result = await $.session.send({ to: { sessionId: s.sessionId }, text: body })
  if (result.isDelivered) {
    await update($, sent, n => n + 1)
    $.ui.toast(`送りました → ${s.name}`)
  } else {
    $.ui.toast(`送れませんでした: ${result.reason}`)
  }
}

// ---- フック ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'このワークスペースのセッション一覧 (のぞく・開く・送る)',
    })
    // 開いている間だけ描き直す。モジュールが読み直されるとタイマーも作り直される
    $.clock.every(EVERY_MS, () => {
      void isPaneOpen($).then(open => (open ? refresh($) : undefined))
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'セッション', focus: true, columns: 60 })
    void refresh($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined

    const snap = await read($, snapshot)
    const loading = await read($, isLoading)
    const chosen = await read($, selected)
    const seen = await read($, peeked)
    const all = await read($, showAll)
    const sentCount = await read($, sent)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{fit(snap?.label || 'このワークスペース', width - 10)}</Text>
        <Button
          key="refresh"
          plain
          dimColor
          hotkey="r"
          label={loading ? '更新中…' : '更新'}
          onPress={() => void refresh($)}
        />
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{loading ? '読み込み中…' : '「更新」で読み込みます'}</Text>
        </Box>
      )
    }

    const live = snap.sessions.filter(s => s.kind !== 'past')
    const past = snap.sessions.filter(s => s.kind === 'past')
    const pastShown = all ? past : past.slice(0, PAST_FOLDED)
    const runningCount = live.filter(s => s.isRunning).length
    let hot = 0

    const row = (s: WsSession) => {
      hot += 1
      const hotkey = hot <= 9 ? String(hot) : undefined
      const dot = dotOf(s)
      const meta = metaOf(s, now)
      const room = width - (hotkey ? 3 : 0) - 2 - cells(meta) - 1
      const isOpen = chosen === s.sessionId
      return (
        <Box key={`item:${s.sessionId}`} flexDirection="column">
          <Button
            key={`row:${s.sessionId}`}
            plain
            {...(hotkey ? { hotkey } : {})}
            onPress={() => void choose($, s)}
          >
            <Text {...(dot.color ? { color: dot.color } : { dimColor: true })}>{dot.glyph}</Text>{' '}
            <Text bold={isOpen}>{fit(s.name, Math.max(8, room))}</Text>{' '}
            <Text dimColor>{meta}</Text>
          </Button>
          {isOpen && detail(s)}
        </Box>
      )
    }

    const detail = (s: WsSession) => {
      const mine = seen?.sessionId === s.sessionId ? seen : undefined
      const command = commandFor(s)
      const canSend = s.isRunning && !s.isSelf
      return (
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          {(!mine || mine.isLoading) && <Text dimColor>のぞいています…</Text>}
          {mine?.error && <Text dimColor>{mine.error}</Text>}
          {mine?.prompt && <Text dimColor>最後の依頼</Text>}
          {mine?.prompt && <Text>{mine.prompt}</Text>}
          {mine?.reply && (
            <Text dimColor>{mine.isAnswered ? '返答' : '返答 (ひとつ前の依頼へ・いまは作業中か待ち)'}</Text>
          )}
          {mine?.reply && <Text>{mine.reply}</Text>}
          {mine && !mine.isLoading && !mine.error && !mine.prompt && !mine.reply && (
            <Text dimColor>まだ発言がありません</Text>
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {!s.isSelf && (command || s.webUrl) && (
              <Button
                key={`open:${s.sessionId}`}
                variant="primary"
                hotkey="o"
                label={s.kind === 'past' ? '再開' : command ? '開く' : 'Web で開く'}
                onPress={press => void openSession($, s, press.surface)}
              />
            )}
            {command && (
              <Button
                key={`copy:${s.sessionId}`}
                hotkey="c"
                label="コマンドをコピー"
                onPress={press => void copyCommand($, s, press.surface)}
              />
            )}
            {s.webUrl && command && (
              <Button
                key={`web:${s.sessionId}`}
                hotkey="w"
                label="Web"
                onPress={() => void openWeb($, s)}
              />
            )}
          </Box>
          {canSend && Input && (
            <Input
              key={`send:${s.sessionId}:${sentCount}`}
              label="送る "
              placeholder="このセッションへのメッセージ"
              submitLabel="送る"
              onSubmit={value => void sendTo($, s, value)}
            />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>
          {fit(
            `動いている ${runningCount} · 過去 ${past.length} · ${ago(snap.loadedAt, now)}に更新`,
            width,
          )}
        </Text>
        {snap.error && <Text color="error">{fit(snap.error, width * 2)}</Text>}
        {live.length > 0 && <Text dimColor>─ いまのセッション</Text>}
        {live.map(row)}
        {past.length > 0 && <Text dimColor>─ 過去のセッション</Text>}
        {pastShown.map(row)}
        {past.length > PAST_FOLDED && (
          <Button
            key="more"
            plain
            dimColor
            hotkey="p"
            label={all ? '過去を畳む' : `過去をすべて (${past.length})`}
            onPress={() => void update($, showAll, v => !v)}
          />
        )}
      </Box>
    )
  })
}
