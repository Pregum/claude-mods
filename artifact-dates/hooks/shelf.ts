import type { Item, Origin, Origins, PreviewLine } from '../types'

const LINE =
  /^- \((?:mine|shared)(, pinned)?[^)]*\) (.*) — (https:\/\/\S+?)(?: — updated (\d{4}-\d{2}-\d{2}))?$/

/** 共有分の題名は他の人が書いたもの。画面を崩す制御文字は落とす */
const clean = (text: string): string => text.replace(/\p{Cc}/gu, ' ').trim()

/** Artifact の list が返す文章を読む。読めない行は飛ばす */
export const parseListing = (text: string): Item[] =>
  text.split('\n').flatMap((line): Item[] => {
    const hit = LINE.exec(line.trimEnd())
    if (!hit?.[2] || !hit[3]) return []
    return [
      {
        url: hit[3],
        title: clean(hit[2]) || 'Untitled',
        ...(hit[4] ? { updated: hit[4] } : {}),
        isPinned: hit[1] !== undefined,
      },
    ]
  })

export type Row = { kind: 'group'; label: string; count: number } | { kind: 'item'; item: Item; group: string }

const dayAt = (at: number): Date => {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

const stamp = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const shifted = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)

/** 日付の入れ物の名前。週は月曜から */
export const groupOf = (updated: string | undefined, now: number): string => {
  if (!updated) return '日付なし'
  const today = dayAt(now)
  const monday = shifted(today, -((today.getDay() + 6) % 7))
  if (updated > stamp(today)) return '今日'
  if (updated === stamp(today)) return '今日'
  if (updated === stamp(shifted(today, -1))) return '昨日'
  if (updated >= stamp(monday)) return '今週'
  if (updated >= stamp(shifted(monday, -7))) return '先週'
  const [year, month] = updated.split('-')
  return `${year}年${Number(month)}月`
}

/** 題名かプロジェクト名に全部の語を含むものだけ。大文字小文字は見ない */
export const matches = (item: Item, filter: string, origin?: Origin): boolean => {
  const text = `${item.title} ${origin?.project ?? ''}`.toLowerCase()
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word => text.includes(word))
}

/** 新しい順に並べて、見出しの行を挟む。日付の無いものは届いた順のまま下へ */
export const rowsOf = (items: readonly Item[], now: number): Row[] => {
  const sorted = items
    .map((item, at) => ({ item, at }))
    .sort((a, b) => (b.item.updated ?? '').localeCompare(a.item.updated ?? '') || a.at - b.at)
    .map(one => one.item)
  const counts = new Map<string, number>()
  for (const item of sorted) {
    const group = groupOf(item.updated, now)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  const rows: Row[] = []
  let last: string | undefined
  for (const item of sorted) {
    const group = groupOf(item.updated, now)
    if (group !== last) rows.push({ kind: 'group', label: group, count: counts.get(group) ?? 0 })
    last = group
    rows.push({ kind: 'item', item, group })
  }
  return rows
}

export type Slice = { rows: Row[]; above: number; below: number }

/** 選んでいる行が入るように切り出す。先頭が項目なら見出しに差し替えて、どの月かを残す */
export const windowOf = (rows: readonly Row[], at: number, room: number): Slice => {
  const size = Math.max(1, room)
  if (rows.length <= size) return { rows: [...rows], above: 0, below: 0 }
  const here = Math.max(0, at)
  const start = Math.min(rows.length - size, Math.max(0, here - Math.floor(size / 3)))
  const shown = rows.slice(start, start + size)
  const top = shown[0]
  if (top?.kind === 'item' && here !== start) {
    const heading = rows.find(row => row.kind === 'group' && row.label === top.group)
    if (heading) shown[0] = heading
  }
  return { rows: shown, above: start, below: rows.length - start - size }
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (text: string): string =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

const HEADING = '\u0001'

/** read の答えから、ページの見出しと文章を抜く。スクリプトや装飾は捨てる */
export const previewOf = (raw: string, limit: number): PreviewLine[] => {
  const start = raw.search(/<(?:!doctype|html|body)\b/i)
  const end = raw.toLowerCase().lastIndexOf('</html>')
  const html = raw.slice(Math.max(0, start), end > start ? end : undefined)
  const lines = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<h[1-3]\b[^>]*>/gi, `\n${HEADING}`)
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:p|li|ul|ol|tr|table|thead|tbody|div|section|article|main|header|footer|h[1-6]|pre|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .flatMap((line): PreviewLine[] => {
      const isHeading = line.includes(HEADING)
      const text = clean(decode(line.replaceAll(HEADING, ''))).replace(/\s+/g, ' ')
      return text ? [{ text, isHeading }] : []
    })
  return lines.slice(0, limit)
}

/** プロンプトへ渡す下書き。URL があれば Claude が読める */
export const draftOf = (item: Item): string => `Artifact「${item.title}」の続きをお願いします。\n${item.url}\n`

const encodeRoot = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

/** 会話は始めたフォルダでしか再開できない。cd していても履歴のフォルダ名から元へ戻す */
export const rootOf = (cwd: string, encoded: string): string => {
  for (let path = cwd; path.length > 1; path = path.slice(0, path.lastIndexOf('/')) || '/') {
    if (encodeRoot(path) === encoded) return path
  }
  return cwd
}

/** grep -r の出力 (パス:JSON の行) から、Artifact ごとの最初の公開を拾う */
export const parseOrigins = (output: string): Origins => {
  const found = new Map<string, Origin & { at: string }>()
  for (const line of output.split('\n')) {
    const split = line.indexOf('.jsonl:')
    if (split < 0) continue
    const encoded = /([^/]+)\/[^/]+$/.exec(line.slice(0, split))?.[1] ?? ''
    let row: { cwd?: unknown; sessionId?: unknown; timestamp?: unknown; toolUseResult?: { url?: unknown } }
    try {
      row = JSON.parse(line.slice(split + '.jsonl:'.length))
    } catch {
      continue
    }
    const { cwd, sessionId, timestamp } = row
    const url = row.toolUseResult?.url
    if (typeof url !== 'string' || typeof cwd !== 'string' || typeof sessionId !== 'string') continue
    const at = typeof timestamp === 'string' ? timestamp : ''
    const known = found.get(url)
    if (known && known.at <= at) continue
    const root = rootOf(cwd, encoded)
    found.set(url, { sessionId, root, project: root.slice(root.lastIndexOf('/') + 1), day: at.slice(0, 10), at })
  }
  return Object.fromEntries([...found].map(([url, { at: _at, ...origin }]) => [url, origin]))
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

export const resumeCommand = (origin: Origin): string =>
  `cd ${shellQuote(origin.root)} && claude --resume ${origin.sessionId}`
