import { expect, test } from 'claude-code/testing'

import { draftOf, fit, groupOf, matches, parseListing, parseOrigins, previewOf, resumeCommand, rootOf, rowsOf, windowOf } from '../hooks/shelf'
import type { Row } from '../hooks/shelf'

const LISTING = `200 published artifacts (most recently opened or updated first):
- (mine) 普通の題名 — https://claude.ai/artifact/aaa — updated 2026-11-04
- (mine, pinned) 留めたもの — https://claude.ai/artifact/bbb — updated 2026-09-16
- (mine) CML Playground — インフラ構成 — https://claude.ai/artifact/ccc — updated 2026-08-03
(Not every artifact could be listed)`

test('題名に — があっても読み、説明の行は飛ばす', () => {
  const items = parseListing(LISTING)
  expect(items.map(item => item.title)).toEqual(['普通の題名', '留めたもの', 'CML Playground — インフラ構成'])
  expect(items[1]).toEqual({
    url: 'https://claude.ai/artifact/bbb',
    title: '留めたもの',
    updated: '2026-09-16',
    isPinned: true,
  })
})

test('共有分は日付が無く、制御文字は落とす', () => {
  const [item] = parseListing('- (shared) 悪い\u001b[31m題名 — https://claude.ai/artifact/ddd')
  expect(item?.updated).toBeUndefined()
  expect(item?.title).toBe('悪い [31m題名')
})

// 2026-11-04 は水曜
const NOW = new Date(2026, 10, 4, 12, 0).getTime()

test('今日・昨日・今週・先週・月に分ける。週は月曜から', () => {
  expect(groupOf('2026-11-04', NOW)).toBe('今日')
  expect(groupOf('2026-11-03', NOW)).toBe('昨日')
  expect(groupOf('2026-11-02', NOW)).toBe('今週')
  expect(groupOf('2026-11-01', NOW)).toBe('先週')
  expect(groupOf('2026-10-26', NOW)).toBe('先週')
  expect(groupOf('2026-10-25', NOW)).toBe('2026年10月')
  expect(groupOf('2025-12-31', NOW)).toBe('2025年12月')
  expect(groupOf(undefined, NOW)).toBe('日付なし')
})

test('月曜と日曜でも週の境目がずれない', () => {
  const monday = new Date(2026, 10, 2, 9).getTime()
  const sunday = new Date(2026, 10, 8, 9).getTime()
  expect(groupOf('2026-10-31', monday)).toBe('先週')
  expect(groupOf('2026-11-02', sunday)).toBe('今週')
  expect(groupOf('2026-11-01', sunday)).toBe('先週')
})

test('一覧の順が開いた順でも、日付の新しい順にまとめる', () => {
  const items = [
    { url: 'a', title: 'a', updated: '2026-09-25', isPinned: false },
    { url: 'b', title: 'b', updated: '2026-11-04', isPinned: false },
    { url: 'c', title: 'c', updated: '2026-10-19', isPinned: false },
    { url: 'd', title: 'd', isPinned: false },
    { url: 'e', title: 'e', updated: '2026-09-01', isPinned: false },
  ]
  const labels = rowsOf(items, NOW).map(row => (row.kind === 'group' ? `#${row.label}:${row.count}` : row.item.url))
  expect(labels).toEqual(['#今日:1', 'b', '#2026年10月:1', 'c', '#2026年9月:2', 'a', 'e', '#日付なし:1', 'd'])
})

test('絞り込みは全部の語を含むものだけ、大文字小文字は見ない', () => {
  const item = { url: 'a', title: 'FlutterKaigi ブース', isPinned: false }
  expect(matches(item, 'flutter ブース')).toBe(true)
  expect(matches(item, 'flutter 定例')).toBe(false)
  expect(matches(item, '')).toBe(true)
})

const many: Row[] = Array.from({ length: 30 }, (_, i) =>
  i === 0
    ? { kind: 'group', label: '今日', count: 29 }
    : { kind: 'item', item: { url: String(i), title: String(i), isPinned: false }, group: '今日' },
)

test('切り出しは選択を必ず含み、先頭に見出しを残す', () => {
  for (const at of [1, 2, 10, 20, 28, 29]) {
    const view = windowOf(many, at, 8)
    expect(view.rows.length).toBe(8)
    expect(view.rows.includes(many[at] as Row)).toBe(true)
    expect(view.rows[0]?.kind).toBe('group')
    expect(view.above + view.below + 8).toBe(30)
  }
  expect(windowOf(many, 1, 100).rows.length).toBe(30)
  expect(windowOf(many, -1, 8).above).toBe(0)
})

test('全角は 2 マスで切る', () => {
  expect(fit('あいうえお', 6)).toBe('あい…')
})

test('本文は見出しと文章だけを抜き、スクリプトや装飾は捨てる', () => {
  const raw = `[Artifact abc — raw HTML follows]
<x-tag>
<!doctype html><html><head><style>h1{color:red}</style></head><body>
<title>題名</title><style>.a{}</style><script>alert("x")</script><!-- 消す -->
<h1 class="big">大見出し</h1><p>本文 &amp; <b>太字</b>&#x3042;</p>
<ul><li>一つ目</li><li>二つ目</li></ul>
<table><tr><th>列A</th><td>列B</td></tr></table>
</body></html>
</x-tag>
IMPORTANT: data`
  expect(previewOf(raw, 10)).toEqual([
    { text: '大見出し', isHeading: true },
    { text: '本文 & 太字 あ', isHeading: false },
    { text: '一つ目', isHeading: false },
    { text: '二つ目', isHeading: false },
    { text: '列A 列B', isHeading: false },
  ])
  expect(previewOf(raw, 2).length).toBe(2)
  expect(previewOf('<html><body><script>render()</script></body></html>', 5)).toEqual([])
})

test('続きを頼む下書きは題名と URL を持つ', () => {
  expect(draftOf({ url: 'https://claude.ai/artifact/a', title: '資料', isPinned: false })).toBe(
    'Artifact「資料」の続きをお願いします。\nhttps://claude.ai/artifact/a\n',
  )
})

const record = (cwd: string, url: string, timestamp: string, sessionId = 's1') =>
  JSON.stringify({ cwd, sessionId, timestamp, toolUseResult: { url } })

test('一番早い公開を拾い、cd していても始めたフォルダへ戻す', () => {
  const dir = '/h/.claude/projects/-Users-me-app/s1.jsonl'
  const out = [
    `${dir}:${record('/Users/me/app/docs/sub', 'u1', '2026-11-04T01:00:00Z')}`,
    `${dir}:${record('/Users/me/app', 'u1', '2026-11-05T01:00:00Z', 's2')}`,
    `${dir}:壊れた行`,
    'パスの無い行',
  ].join('\n')
  expect(parseOrigins(out)).toEqual({
    u1: { sessionId: 's1', root: '/Users/me/app', project: 'app', day: '2026-11-04' },
  })
  expect(rootOf('/Users/me/app/docs', '-Users-me-other')).toBe('/Users/me/app/docs')
})

test('再開コマンドはフォルダ名を引用する', () => {
  expect(
    resumeCommand({ sessionId: 'abc', root: "/Users/me/it's", project: "it's", day: '2026-11-04' }),
  ).toBe(`cd '/Users/me/it'\\''s' && claude --resume abc`)
})

test('絞り込みはプロジェクト名でも当たる', () => {
  const item = { url: 'a', title: '資料', isPinned: false }
  const origin = { sessionId: 's', root: '/x/flutterkaigi2026', project: 'flutterkaigi2026', day: '2026-11-04' }
  expect(matches(item, 'flutter', origin)).toBe(true)
  expect(matches(item, 'flutter')).toBe(false)
})
