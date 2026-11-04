import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Listing, Lists, Origins, Previews, ShelfScope } from '../types'
import {
  cells,
  draftOf,
  fit,
  matches,
  padTo,
  parseListing,
  parseOrigins,
  previewOf,
  resumeCommand,
  rowsOf,
  windowOf,
} from './shelf'
import type { Row } from './shelf'

type Engine = EngineInterface

const PANE = 'artifact-dates'
const TITLE = 'Artifacts'
const COMMAND = 'artifacts-by-date'
const LIMIT = 200
const WANTED_ROWS = 32
/** 止まってからこれだけ待って本文を読む。動くたびに読まない */
const PREVIEW_DELAY_MS = 350
const PREVIEW_ROWS = 9
/** これより低いペインではプレビューを出さない */
const PREVIEW_MIN_BODY = 18
/** 手元に残す本文の数 */
const PREVIEW_KEEP = 40
/** 見出しとキー案内の行数 */
const CHROME_ROWS = 4
const FILTER_INPUT = 'filter-input'

const SCOPES: readonly { scope: ShelfScope; label: string; hotkey: string }[] = [
  { scope: 'mine', label: '自分', hotkey: '1' },
  { scope: 'shared', label: '共有', hotkey: '2' },
]

const scopeNow = atom({ plugin: 'artifact-dates', key: 'scope' } as const, 'mine')
// 形を変えたら shape の札を変える: 前の版が残した値を読まずに初期値から始める
const lists = atom({ plugin: 'artifact-dates', key: 'lists' } as const, {}, { shape: 'lists-1' })
const isLoading = atom({ plugin: 'artifact-dates', key: 'isLoading' } as const, false)
const selected = atom({ plugin: 'artifact-dates', key: 'selected' } as const, null)
const filterNow = atom({ plugin: 'artifact-dates', key: 'filter' } as const, '')
const isFiltering = atom({ plugin: 'artifact-dates', key: 'isFiltering' } as const, false)

const previews = atom({ plugin: 'artifact-dates', key: 'previews' } as const, {}, { shape: 'previews-1' })
const previewing = atom({ plugin: 'artifact-dates', key: 'previewing' } as const, null)
const origins = atom({ plugin: 'artifact-dates', key: 'origins' } as const, {}, { shape: 'origins-1' })
const showPreview = atom({ plugin: 'artifact-dates', key: 'showPreview' } as const, true)

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const rowKey = (item: Item): string => `art:${item.url}`

const shownItems = (data: Listing | undefined, filter: string, known: Origins): Item[] =>
  (data?.items ?? []).filter(item => matches(item, filter, known[item.url]))

/** 公開の記録だけを拾う。一覧を読んだだけの会話は入らない */
const PUBLISH_RECORD = '"toolUseResult":\\{"url":"https://claude\\.ai/artifact/'

async function loadOrigins($: Engine): Promise<void> {
  const script = `grep -rE --include='*.jsonl' '${PUBLISH_RECORD}' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"`
  const ran = await $.process.run(['sh', '-c', script], { timeoutMs: 20000 }).catch(() => undefined)
  if (ran?.stdout) await update($, origins, () => parseOrigins(ran.stdout))
}

async function fetchList($: Engine, scope: ShelfScope): Promise<Item[]> {
  const out = await $.tool.call({ tool: 'Artifact', action: 'list', scope, limit: LIMIT })
  if ('deny' in out && out.deny) throw new Error(out.deny)
  const text = out.text ?? ''
  if (out.isError) throw new Error(text || 'Artifact の一覧を読めませんでした')
  return parseListing(text)
}

const loading = new Set<ShelfScope>()

async function load($: Engine): Promise<void> {
  const scope = await read($, scopeNow)
  if (loading.has(scope)) return
  loading.add(scope)
  await update($, isLoading, () => true)
  const loadedAt = await $.clock.now()
  try {
    const items = await fetchList($, scope)
    await update($, lists, (prev: Lists) => ({ ...prev, [scope]: { items, loadedAt } }))
  } catch (err) {
    const error = message(err)
    await update($, lists, (prev: Lists) => ({
      ...prev,
      [scope]: { items: prev[scope]?.items ?? [], loadedAt, error },
    }))
  } finally {
    loading.delete(scope)
    await update($, isLoading, () => loading.size > 0)
  }
}

/** 今の一覧と絞り込みで、選択が消えていたら先頭へ。並びは日付順 */
async function ordered($: Engine): Promise<Item[]> {
  const scope = await read($, scopeNow)
  const data = (await read($, lists))[scope]
  const filter = await read($, filterNow)
  const now = await $.clock.now()
  const known = await read($, origins)
  return rowsOf(shownItems(data, filter, known), now).flatMap(row => (row.kind === 'item' ? [row.item] : []))
}

async function current($: Engine): Promise<Item | undefined> {
  const items = await ordered($)
  const id = await read($, selected)
  return items.find(item => item.url === id) ?? items[0]
}

async function loadPreview($: Engine): Promise<void> {
  if (!(await read($, showPreview)) || (await read($, scopeNow)) !== 'mine') return
  const item = await current($)
  if (!item || (await read($, previews))[item.url]) return
  await update($, previewing, () => item.url)
  const keep = (entry: Previews[string]) =>
    update($, previews, (prev: Previews) =>
      Object.fromEntries([...Object.entries(prev), [item.url, entry]].slice(-PREVIEW_KEEP)),
    )
  try {
    const out = await $.tool.call({ tool: 'Artifact', action: 'read', url: item.url })
    if ('deny' in out && out.deny) throw new Error(out.deny)
    if (out.isError) throw new Error(out.text || '本文を読めませんでした')
    await keep({ lines: previewOf(out.text ?? '', PREVIEW_ROWS * 3) })
  } catch (err) {
    await keep({ lines: [], error: message(err) })
  } finally {
    await update($, previewing, () => null)
  }
}

let previewTicket = 0

const schedulePreview = ($: Engine): void => {
  previewTicket += 1
  const ticket = previewTicket
  $.clock.after(PREVIEW_DELAY_MS, () => {
    if (ticket === previewTicket) void loadPreview($).catch(() => undefined)
  })
}

async function copyResume($: Engine, surface: Parameters<typeof $.ui.copy>[0]['surface']): Promise<void> {
  const item = await current($)
  const origin = item && (await read($, origins))[item.url]
  if (!origin) {
    $.ui.toast('作った会話が手元の履歴に見つかりません')
    return
  }
  const text = resumeCommand(origin)
  const done = await $.ui.copy({ text, ...(surface ? { surface } : {}) })
  $.ui.toast(done.isCopied ? `再開コマンドをコピーしました: ${origin.project}` : `コピーできませんでした: ${text}`)
}

async function askClaude($: Engine, item: Item): Promise<void> {
  // 打ちかけの下書きを消さないよう、カーソルの位置に入れる
  const filled = await $.prompt.fill({ text: draftOf(item), mode: 'insert' }).catch(() => undefined)
  if (!filled?.isFilled) {
    $.ui.toast('プロンプトへ入れられませんでした')
    return
  }
  await closePane($)
}

/** 描き直しが終わる前に帯を動かすと前の行に残るので、少し待ってもう一度動かす */
async function focusKey($: Engine, key: string): Promise<void> {
  const target = { requestId: PANE, key }
  await $.ui.focus(target).catch(() => undefined)
  $.clock.after(66, () => void $.ui.focus(target).catch(() => undefined))
}

const focusRow = ($: Engine, url: string): Promise<void> => focusKey($, `art:${url}`)

/** 入力欄の autoFocus は帯のある行からキーを奪わないので、明示して移す */
async function toggleFilter($: Engine): Promise<void> {
  const open = !(await read($, isFiltering))
  await update($, isFiltering, () => open)
  if (open) await focusKey($, FILTER_INPUT)
  else await settleSelection($)
}

let moves: Promise<void> = Promise.resolve()

/** j / k を順に動かす。並んで走ると、押した数だけ進まない */
const queueMove = ($: Engine, by: number): void => {
  moves = moves
    .then(async () => {
      const items = await ordered($)
      const id = await read($, selected)
      const at = items.findIndex(item => item.url === id)
      // 選択が今の並びに無ければ、画面の › と同じ先頭として扱う
      const next = items[Math.min(items.length - 1, Math.max(0, (at < 0 ? 0 : at) + by))]
      if (!next) return
      await update($, selected, () => next.url)
      await focusRow($, next.url)
      schedulePreview($)
    })
    .catch(() => undefined)
}

/** 読み終えたら帯を選んでいる行へ。そのままだと Enter がタブを押してしまう */
async function settleSelection($: Engine): Promise<void> {
  const items = await ordered($)
  const id = await read($, selected)
  const next = items.find(item => item.url === id) ?? items[0]
  await update($, selected, () => next?.url ?? null)
  if (next) await focusRow($, next.url)
  schedulePreview($)
}

async function loadAndFocus($: Engine): Promise<void> {
  await load($)
  await settleSelection($)
}

async function changeScope($: Engine, scope: ShelfScope): Promise<void> {
  await update($, scopeNow, () => scope)
  await update($, selected, () => null)
  await update($, filterNow, () => '')
  await update($, isFiltering, () => false)
  await settleSelection($)
  await loadAndFocus($)
}

async function openItem($: Engine, item: Item): Promise<void> {
  await update($, selected, () => item.url)
  for (const opener of ['open', 'xdg-open']) {
    const ran = await $.process.run([opener, item.url], { timeoutMs: 10000 }).catch(() => undefined)
    if (ran?.exitCode === 0) return
  }
  $.ui.toast(`開けませんでした: ${item.url}`)
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
    await $.command.register({
      name: COMMAND,
      description: 'Artifact を日付で分けて開く。キーがあれば閉じる',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const { isOpen, isFocused } = await isShown($)
    if (isOpen && isFocused) {
      await closePane($)
      return {}
    }
    await update($, isFiltering, () => false)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: WANTED_ROWS })
    void loadOrigins($)
    void loadAndFocus($)
    return {}
  })

  // 矢印・Tab・クリックで帯が動いたら、選択も合わせる
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const done = await next(e)
    // 自分で動かした帯の遅れた分で、選択を前へ戻さない
    const url = /^art:(.+)$/.exec(e.element ?? '')?.[1]
    if (url !== undefined && e.origin.kind === 'person') {
      await update($, selected, () => url)
      schedulePreview($)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : undefined

    const scope = await read($, scopeNow)
    const data = (await read($, lists))[scope]
    const busy = await read($, isLoading)
    const stored = await read($, selected)
    const filter = await read($, filterNow)
    const filtering = await read($, isFiltering)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)

    const known = await read($, origins)
    const items = shownItems(data, filter, known)
    const rows = rowsOf(items, now)
    // 選択が絞り込みで消えたら先頭に › を出す。キーの動きも ordered の先頭に合わせる
    const firstRow = rows.find(row => row.kind === 'item')
    const chosen = items.some(item => item.url === stored)
      ? stored
      : firstRow?.kind === 'item'
        ? firstRow.item.url
        : null
    const at = rows.findIndex(row => row.kind === 'item' && row.item.url === chosen)
    const bodyRows = e.props.scroll.bodyRows
    const previewOn = (await read($, showPreview)) && bodyRows >= PREVIEW_MIN_BODY
    const chosenItem = items.find(item => item.url === chosen)
    const preview = chosen ? (await read($, previews))[chosen] : undefined
    const reading = (await read($, previewing)) === chosen
    const origin = chosen ? known[chosen] : undefined
    const room = Math.max(
      4,
      bodyRows - CHROME_ROWS - (filtering ? 3 : 0) - 2 - (previewOn ? PREVIEW_ROWS + 1 : 0),
    )
    const view = windowOf(rows, at, room)

    const line = (row: Row) => {
      if (row.kind === 'group') {
        return (
          <Text key={`group:${row.label}`} bold color="claude">
            {row.label}
            <Text dimColor>{` ${row.count}`}</Text>
          </Text>
        )
      }
      const { item } = row
      const isHere = item.url === chosen
      const tail = item.updated ? ` ${item.updated.slice(5).replace('-', '/')}` : ''
      const mark = item.isPinned ? '★ ' : ''
      const space = Math.max(6, width - 2 - cells(tail) - cells(mark))
      return (
        <Button
          key={rowKey(item)}
          plain
          {...(isHere ? { autoFocus: true as const } : {})}
          onPress={() => void openItem($, item)}
        >
          <Text color="claude" bold={isHere}>{isHere ? '› ' : '  '}</Text>
          {item.isPinned && <Text color="warning">{mark}</Text>}
          <Text bold={isHere}>{padTo(fit(item.title, space), space)}</Text>
          <Text dimColor>{tail}</Text>
        </Button>
      )
    }

    const copyChosen = (surface: Parameters<typeof $.ui.copy>[0]['surface']) => {
      if (!chosen) return
      void $.ui.copy({ text: chosen, ...(surface ? { surface } : {}) }).then(done => {
        $.ui.toast(done.isCopied ? 'URL をコピーしました' : `コピーできませんでした: ${chosen}`)
      })
    }

    const total = data?.items.length ?? 0
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold color="claude">◆ Artifacts</Text>
          {data && (
            <Text bold>
              {filter ? `${items.length} / ${total}` : String(total)}
              <Text dimColor> 件</Text>
            </Text>
          )}
          {total >= LIMIT && <Text dimColor>{`最近の ${LIMIT} 件まで`}</Text>}
          {busy && <Text dimColor>更新中…</Text>}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {SCOPES.map(one => (
            <Button
              key={`scope:${one.scope}`}
              plain
              dimColor={one.scope !== scope}
              hotkey={one.hotkey}
              label={one.label}
              onPress={() => void changeScope($, one.scope)}
            />
          ))}
          {Input && (
            <Button
              key="filter"
              plain
              dimColor
              hotkey="f"
              label={filter ? `絞り込み: ${fit(filter, 12)}` : '絞り込み'}
              onPress={() => void toggleFilter($)}
            />
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="next" plain dimColor hotkey="j" label="次" onPress={() => queueMove($, 1)} />
          <Button key="prev" plain dimColor hotkey="k" label="前" onPress={() => queueMove($, -1)} />
          <Button
            key="ask"
            plain
            dimColor
            hotkey="i"
            label="続きを頼む"
            onPress={() => {
              if (chosenItem) void askClaude($, chosenItem)
            }}
          />
          <Button
            key="preview"
            plain
            dimColor
            hotkey="p"
            label="本文"
            onPress={() => {
              void update($, showPreview, value => !value).then(() => schedulePreview($))
            }}
          />
          <Button key="copy" plain dimColor hotkey="c" label="URL" onPress={press => copyChosen(press.surface)} />
          <Button
            key="resume"
            plain
            dimColor
            hotkey="s"
            label="作った会話"
            onPress={press => void copyResume($, press.surface).catch(() => undefined)}
          />
          <Button key="refresh" plain dimColor hotkey="r" label="更新" onPress={() => void load($)} />
          <Button key="close" plain dimColor hotkey="q" label="閉じる" onPress={() => void closePane($)} />
          <Text dimColor>Enter: 開く</Text>
        </Box>
        {filtering && Input && (
          <Input
            key={FILTER_INPUT}
            label="絞り込み "
            placeholder="題名の語。空白で区切ると全部を含むもの"
            submitLabel="決定"
            value={filter}
            autoFocus
            onInput={value => void update($, filterNow, () => value)}
            onSubmit={value => {
              void (async () => {
                await update($, filterNow, () => value.trim())
                await update($, isFiltering, () => false)
                await update($, selected, () => null)
                await settleSelection($)
              })()
            }}
          />
        )}
        {data?.error && <Text color="error">{fit(data.error, width * 2)}</Text>}
        {data && !data.error && rows.length === 0 && (
          <Text dimColor>{filter ? '当てはまる Artifact はありません' : 'Artifact はありません'}</Text>
        )}
        {!data && <Text dimColor>読み込み中…</Text>}
        {view.above > 0 && <Text dimColor>{`↑ ${view.above} 行`}</Text>}
        {view.rows.map(line)}
        {view.below > 0 && <Text dimColor>{`↓ ${view.below} 行`}</Text>}
        {previewOn && chosenItem && (
          <Box flexDirection="column" height={PREVIEW_ROWS + 1} overflow="hidden">
            <Text dimColor>
              {padTo(
                fit(origin ? `── ${origin.project}  ${origin.day} に作成` : '── 作った会話は不明', width - 2),
                width - 2,
              )}
            </Text>
            {scope === 'shared' && <Text dimColor>共有の Artifact の本文は読みません</Text>}
            {scope === 'mine' && preview?.error && <Text color="error">{fit(preview.error, width * 2)}</Text>}
            {scope === 'mine' && !preview && <Text dimColor>{reading ? '本文を読み込み中…' : ' '}</Text>}
            {scope === 'mine' && preview && !preview.error && preview.lines.length === 0 && (
              <Text dimColor>本文を取り出せません (スクリプトで描くページかもしれません)</Text>
            )}
            {scope === 'mine' &&
              preview?.lines.slice(0, PREVIEW_ROWS).map((one, i) => (
                <Text key={`preview:${i}`} {...(one.isHeading ? { bold: true, color: 'claude' as const } : {})}>
                  {fit(one.text, width - 2)}
                </Text>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
