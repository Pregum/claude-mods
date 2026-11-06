import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { MapLink, MapNode, PluginInfo, SkillGraph, SourceFile } from '../types'
import { bodyOf, buildGraph, refName } from './graph'
import { components, drawGraph, pickSide, sliceLine, treeEdges, wrapLines } from './layout'
import type { Drawing, GraphEdge } from './layout'

const PANE = 'skill-map'
const TITLE = 'スキルの地図'
const READ_BATCH = 24
const PICK_LIMIT = 30
const FOCUS_DEPTH = 2
// これより大きい塊は線が読めなくなるので木に絞る
const TREE_THRESHOLD = 14
const PANE_MARGIN = 2
const DESCRIPTION_LINES = 3
const DETAIL_FRAME = 4
const READ_CHROME_ROWS = 6
const READ_STEP = 5
const SCROLL_STEP = 16
// ノードへ入る矢印も見えるよう、左に残す幅
const REVEAL_CONTEXT = 6
const DEFAULT_OPEN = ['project', 'user']
// Claude Code に同梱のスキル。一覧に出ないことがあるので、同名の plugin のスキルと取り違えないよう足す。
const BUNDLED_COMMANDS = ['init', 'review', 'simplify', 'security-review', 'code-review', 'loop', 'schedule', 'run']
const KEY_HELP = [
  ['j k ↑ ↓', 'ノードや行を上下に移動（本文ではスクロール）'],
  ['h l', '左右の段へ移動（図が長いときは横にスクロール）'],
  ['Enter', '選んだスキルを中心にする / 中心なら本文を読む'],
  ['t', 'グラフ / 一覧を切り替え（一覧で開いたグループが図に入る）'],
  ['b', '前のスキルへ戻る / 絞り込みを解除'],
  ['f', '名前で絞り込む（Enter で確定、Esc で取り消し）'],
  ['o', '選んだスキルのファイルを開く'],
  ['r', '中心から呼ぶ先のつなぎ先を付け替える'],
  ['x', '中心から呼ぶ先への参照を外す'],
  ['a', '今のスキルから別のスキルへつなぐ'],
  ['m', '組み合わせる候補に印を付ける'],
  ['c', '印のスキルを順に呼ぶスキルを作る'],
  ['u', '読み直す'],
  ['q Esc', 'ペインを閉じる'],
  ['i', 'このキー一覧を閉じる'],
]

const EMPTY: SkillGraph = { nodes: [], links: [] }

const graph = atom({ plugin: 'skill-map', key: 'graph' } as const, EMPTY, { shape: 'graph-1' })
const plugins = atom({ plugin: 'skill-map', key: 'plugins' } as const, [], { shape: 'plugins-1' })
const trail = atom({ plugin: 'skill-map', key: 'trail' } as const, [], { shape: 'trail-1' })
const openGroups = atom({ plugin: 'skill-map', key: 'openGroups' } as const, DEFAULT_OPEN, { shape: 'groups-1' })
const marks = atom({ plugin: 'skill-map', key: 'marks' } as const, [], { shape: 'marks-1' })
const picker = atom({ plugin: 'skill-map', key: 'picker' } as const, null, { shape: 'picker-1' })
const reading = atom({ plugin: 'skill-map', key: 'reading' } as const, null, { shape: 'reading-1' })
const readTop = atom({ plugin: 'skill-map', key: 'readTop' } as const, 0)
const scrollX = atom({ plugin: 'skill-map', key: 'scrollX' } as const, 0)
const cursor = atom({ plugin: 'skill-map', key: 'cursor' } as const, '')
const query = atom({ plugin: 'skill-map', key: 'query' } as const, '')
const isFiltering = atom({ plugin: 'skill-map', key: 'isFiltering' } as const, false)
const isHelpOpen = atom({ plugin: 'skill-map', key: 'isHelpOpen' } as const, false)
const isListView = atom({ plugin: 'skill-map', key: 'isListView' } as const, false)
const isScanning = atom({ plugin: 'skill-map', key: 'isScanning' } as const, false)
const lastError = atom({ plugin: 'skill-map', key: 'error' } as const, '')

type Host = Parameters<Hook<'session.start'>>[0]
type Source = Omit<SourceFile, 'text'>

let cwd = ''

const entries = ($: Host, dir: string) => $.fs.list(dir).catch(() => [])

/** skills/<名前>/SKILL.md を集める。シンボリックリンクのスキルも同じ形で読む。 */
const skillSources = async ($: Host, dir: string, group: string): Promise<Source[]> =>
  (await entries($, dir))
    .filter(one => one.kind !== 'file' && !one.name.startsWith('.') && one.name !== 'synced')
    .map(one => ({
      kind: 'skill',
      group,
      name: one.name,
      path: `${dir}/${one.name}/SKILL.md`,
    }))

const markdownSources = async (
  $: Host,
  dir: string,
  group: string,
  kind: 'command' | 'agent',
  namespace = '',
): Promise<Source[]> => {
  const found: Source[] = []
  for (const one of await entries($, dir)) {
    if (one.name.startsWith('.')) continue
    if (one.kind === 'file' && one.name.endsWith('.md')) {
      found.push({ kind, group, name: `${namespace}${one.name.slice(0, -3)}`, path: `${dir}/${one.name}` })
    } else if (one.kind === 'dir') {
      found.push(...(await markdownSources($, `${dir}/${one.name}`, group, kind, `${namespace}${one.name}:`)))
    }
  }

  return found
}

const sourcesIn = async ($: Host, root: string, group: string) => [
  ...(await skillSources($, `${root}/skills`, group)),
  ...(await markdownSources($, `${root}/commands`, group, 'command')),
  ...(await markdownSources($, `${root}/agents`, group, 'agent')),
]

const syncedSources = async ($: Host, home: string) => {
  const root = `${home}/.claude/skills/synced`
  const buckets = (await entries($, root)).filter(one => one.kind === 'dir')
  const lists = await Promise.all(
    buckets.map(one => skillSources($, `${root}/${one.name}`, 'synced')),
  )

  return lists.flat()
}

type InstalledPlugin = { id: string; enabled: boolean; installPath: string }

const listPlugins = async ($: Host) => {
  const { exitCode, stdout } = await $.process.run(['claude', 'plugin', 'list', '--json'])
  if (exitCode !== 0) throw new Error('claude plugin list に失敗しました')

  return JSON.parse(stdout) as InstalledPlugin[]
}

const pluginGroup = (plugin: InstalledPlugin) => `plugin:${plugin.id.split('@')[0] ?? plugin.id}`

const readAll = async ($: Host, sources: Source[]) => {
  const files: SourceFile[] = []
  for (let at = 0; at < sources.length; at += READ_BATCH) {
    const batch = sources.slice(at, at + READ_BATCH)
    const texts = await Promise.all(
      batch.map(one => $.fs.read(one.path).catch(() => undefined)),
    )
    batch.forEach((one, index) => {
      const text = texts[index]
      if (text !== undefined) files.push({ ...one, text })
    })
  }

  return files
}

const scan = async ($: Host) => {
  await update($, isScanning, () => true)
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const installed = await listPlugins($)
    const enabled = installed.filter(one => one.enabled)
    const inPlugins = await Promise.all(
      enabled.map(one => sourcesIn($, one.installPath, pluginGroup(one))),
    )
    const sources = [
      ...(await sourcesIn($, `${cwd}/.claude`, 'project')),
      ...(await sourcesIn($, `${home}/.claude`, 'user')),
      ...(await syncedSources($, home)),
      ...inPlugins.flat(),
    ]
    const commands = await $.command.list()
    const builtins = new Set([
      ...BUNDLED_COMMANDS,
      ...commands.filter(one => one.source === 'builtin').map(one => one.name),
    ])
    const next = buildGraph(await readAll($, sources), builtins)
    const info = await Promise.all(
      installed.map(
        async (one): Promise<PluginInfo> => ({
          group: pluginGroup(one),
          isEnabled: one.enabled,
          hasHooks: await $.fs.exists(`${one.installPath}/hooks/hooks.json`),
          hasMcp: await $.fs.exists(`${one.installPath}/.mcp.json`),
        }),
      ),
    )
    await update($, graph, () => next)
    await update($, plugins, () => info)
    await update($, lastError, () => '')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, lastError, () => message.slice(0, 160))
  } finally {
    await update($, isScanning, () => false)
  }
}

type Row =
  | { kind: 'label'; key: string; text: string; note?: string }
  | { kind: 'group'; key: string; text: string; note: string; group: string; isOpen: boolean }
  | {
      kind: 'node'
      key: string
      text: string
      note?: string
      node: MapNode
      /** 今見ているスキルから出ている直接の参照 */
      link?: MapLink
    }

const groupLabel = (group: string) => {
  if (group === 'project') return 'このプロジェクト'
  if (group === 'user') return '自分のスキル'
  if (group === 'synced') return '同期スキル'
  return group.slice('plugin:'.length)
}

const GROUP_ORDER = ['project', 'user', 'synced']

const orderedGroups = (nodes: MapNode[], info: PluginInfo[]) => {
  const named = [...new Set([...nodes.map(one => one.group), ...info.map(one => one.group)])]
  const rest = named.filter(one => !GROUP_ORDER.includes(one)).sort()

  return [...GROUP_ORDER.filter(one => named.includes(one)), ...rest]
}

const linkCounts = (map: SkillGraph) => {
  const counts = new Map<string, { out: number; in: number }>()
  const at = (id: string) => {
    const count = counts.get(id) ?? { out: 0, in: 0 }
    counts.set(id, count)
    return count
  }
  for (const link of map.links) {
    at(link.from).out += 1
    at(link.to).in += 1
  }

  return { of: at }
}

const countText = (count: { out: number; in: number }) =>
  count.out + count.in === 0 ? 'つながりなし' : `→${count.out} ←${count.in}`

const nodeRow = (node: MapNode, counts: ReturnType<typeof linkCounts>, prefix: string): Row => ({
  kind: 'node',
  key: `row:${prefix}${node.id}`,
  text: node.name,
  note: countText(counts.of(node.id)),
  node,
})

const matches = (node: MapNode, text: string) =>
  `${node.name} ${node.description}`.toLowerCase().includes(text.toLowerCase())

const groupNote = (nodes: MapNode[], info: PluginInfo | undefined) => {
  if (info && !info.isEnabled) return '無効'

  const parts = [
    nodes.length > 0 ? `${nodes.length} 件` : '',
    info?.hasHooks ? 'hook' : '',
    info?.hasMcp ? 'MCP' : '',
    nodes[0]?.isEditable === false || info ? '読み取り専用' : '',
  ]

  return parts.filter(Boolean).join(' · ')
}

export const homeRows = (
  map: SkillGraph,
  info: PluginInfo[],
  open: string[],
  text: string,
): Row[] => {
  const counts = linkCounts(map)
  if (text) {
    return map.nodes.filter(one => matches(one, text)).map(one => nodeRow(one, counts, ''))
  }

  return orderedGroups(map.nodes, info).flatMap((group): Row[] => {
    const nodes = map.nodes.filter(one => one.group === group)
    const isOpen = open.includes(group)
    const header: Row = {
      kind: 'group',
      key: `group:${group}`,
      text: `${isOpen ? '▾' : '▸'} ${groupLabel(group)}`,
      note: groupNote(nodes, info.find(one => one.group === group)),
      group,
      isOpen,
    }
    if (!isOpen) return [header]

    const links = (one: MapNode) => counts.of(one.id).out + counts.of(one.id).in
    const sorted = [...nodes].sort(
      (a, b) => links(b) - links(a) || a.name.localeCompare(b.name),
    )

    return [header, ...sorted.map(one => nodeRow(one, counts, ''))]
  })
}

const refLine = (title: string, link: MapLink) =>
  `${title} L${link.line}${link.isPathOnly ? ' ファイルパスのみ' : ''}: ${link.excerpt}`

const toEdges = (links: MapLink[]): GraphEdge[] =>
  links.map(({ from, to }) => ({ from, to }))

/** 木の辺に、同じ 2 点の逆向きの参照を足す（相互参照を ◀▶ で見せる）。 */
const withReverse = (kept: GraphEdge[], all: GraphEdge[]) => [
  ...kept,
  ...all.filter(one => kept.some(edge => edge.from === one.to && edge.to === one.from)),
]

export type GraphBlock = { key: string; drawing: Drawing; omitted: number }

/** 中心のスキルと、呼ぶ元、呼ぶ先 2 段までの図。 */
export const focusBlock = (map: SkillGraph, id: string): GraphBlock => {
  const all = toEdges(map.links)
  const tree = treeEdges([id], all, FOCUS_DEPTH)
  const shown = new Set([id, ...tree.map(one => one.to)])
  const callers = all.filter(one => one.to === id && !shown.has(one.from))
  const edges = [...withReverse(tree, all), ...callers]
  const ids = [...callers.map(one => one.from), id, ...tree.map(one => one.to)]
  const inside = new Set(ids)
  const total = all.filter(one => inside.has(one.from) && inside.has(one.to)).length

  return {
    key: `focus:${id}`,
    drawing: drawGraph(ids, edges, nameOf(map)),
    omitted: Math.max(0, total - edges.length),
  }
}

const nameOf = (map: SkillGraph) => {
  const names = new Map(map.nodes.map(one => [one.id, one.name]))
  return (id: string) => names.get(id) ?? id
}

/** 開いているグループのつながりを、塊ごとの図にする。 */
export const overviewBlocks = (map: SkillGraph, open: string[]) => {
  const seeds = new Set(map.nodes.filter(one => open.includes(one.group)).map(one => one.id))
  const edges = toEdges(map.links).filter(one => seeds.has(one.from) || seeds.has(one.to))
  const ids = [...new Set(edges.flatMap(one => [one.from, one.to]))]
  const linked = new Set(ids)

  const blocks = components(ids, edges).map((group): GraphBlock => {
    const inside = new Set(group)
    const own = edges.filter(one => inside.has(one.from) && inside.has(one.to))
    const targets = new Set(own.map(one => one.to))
    const roots = group.filter(id => !targets.has(id))
    const isLarge = group.length > TREE_THRESHOLD
    const kept = isLarge
      ? withReverse(treeEdges(roots.length > 0 ? roots : group.slice(0, 1), own), own)
      : own

    return {
      key: `block:${group[0]}`,
      drawing: drawGraph(group, kept, nameOf(map)),
      omitted: own.length - kept.length,
    }
  })

  return { blocks, isolated: [...seeds].filter(id => !linked.has(id)).length }
}

const graphRows = (map: SkillGraph, blocks: GraphBlock[], focusedId?: string): Row[] => {
  const nodes = new Map(map.nodes.map(one => [one.id, one]))

  return blocks.flatMap(block =>
    block.drawing.nodeIds.flatMap((id): Row[] => {
      const node = nodes.get(id)
      if (!node) return []

      const link = map.links.find(one => one.from === focusedId && one.to === id)
      const caller = map.links.find(one => one.from === id && one.to === focusedId)
      const shown = link ?? caller
      return [
        {
          kind: 'node',
          key: nodeKey(id),
          text: node.name,
          ...(shown ? { note: refLine(link ? '呼ぶ箇所' : '呼ばれる箇所', shown) } : {}),
          node,
          ...(link ? { link } : {}),
        },
      ]
    }),
  )
}

const nodeKey = (id: string) => `row:g:${id}`

export const pickerRows = (map: SkillGraph, from: string, text: string): Row[] => {
  const counts = linkCounts(map)

  return map.nodes
    .filter(one => one.id !== from && (!text || matches(one, text)))
    .slice(0, PICK_LIMIT)
    .map(one => ({ ...nodeRow(one, counts, 'pick:'), note: groupLabel(one.group) }))
}

// 行頭や連続する空白が詰められて図が崩れないよう、詰められない空白にする。
const solid = (text: string) => text.replaceAll(' ', '\u00a0')

const isRowTarget = (row: Row) => row.kind !== 'label'

/** 移動先の行。位置が分からないときは既定の行から数え、端では止まる。 */
export const pickRow = (keys: string[], current: string, home: string | undefined, by: number) => {
  const at = keys.indexOf(current)
  const from = at >= 0 ? at : Math.max(0, keys.indexOf(home ?? ''))

  return keys[Math.min(keys.length - 1, Math.max(0, from + by))]
}

/** 同じ要素へのフォーカスでは通知が来ないので、位置はここで覚える。 */
const moveTo = async ($: Host, key: string) => {
  await update($, cursor, () => key)
  try {
    await $.ui.focus({ requestId: PANE, key })
    await $.ui.scroll({ to: { key }, in: PANE, block: 'nearest' })
  } catch {
    // 描画がまだない場合など。次のキー入力で合わせる。
  }
}

const leftOf = (block: GraphBlock, offset: number, columns: number) =>
  Math.min(offset, Math.max(0, block.drawing.width - columns))

/** ノードが窓の外にあれば、見える位置まで横にスクロールする。 */
const revealNode = async ($: Host, blocks: GraphBlock[], id: string, columns: number) => {
  const block = blocks.find(one => one.drawing.places.some(place => place.id === id))
  const place = block?.drawing.places.find(one => one.id === id)
  if (!block || !place) return

  const left = leftOf(block, await read($, scrollX), columns)
  const end = place.x + place.width
  if (place.x < left) await update($, scrollX, () => Math.max(0, place.x - REVEAL_CONTEXT))
  else if (end > left + columns) await update($, scrollX, () => end - columns)
}

const moveCursor = async (
  $: Host,
  rows: Row[],
  home: string | undefined,
  blocks: GraphBlock[],
  columns: number,
  by: number,
) => {
  const keys = rows.filter(isRowTarget).map(row => row.key)
  const target = pickRow(keys, await read($, cursor), home, by)
  if (!target) return

  await revealNode($, blocks, target.slice(nodeKey('').length), columns)
  await moveTo($, target)
}

/** 隣の段へ移る。隣がなければ、図の残りを見られるよう横にだけ動かす。 */
const moveSide = async (
  $: Host,
  home: string | undefined,
  blocks: GraphBlock[],
  columns: number,
  by: number,
) => {
  const key = (await read($, cursor)) || home || ''
  const current = key.slice(nodeKey('').length)
  const block = blocks.find(one => one.drawing.places.some(place => place.id === current))
  const target = block && pickSide(block.drawing.places, current, by)
  if (target) {
    await revealNode($, blocks, target, columns)
    await moveTo($, nodeKey(target))
    return
  }
  const widest = Math.max(0, ...blocks.map(one => one.drawing.width - columns))
  await update($, scrollX, left =>
    Math.max(0, Math.min(widest, left + by * SCROLL_STEP)),
  )
}

const openReader = async ($: Host, node: MapNode) => {
  const path = node.paths[0]
  const text = path ? await $.fs.read(path).catch(() => undefined) : undefined
  if (text === undefined) {
    $.ui.toast(`読めませんでした: ${node.name}`)
    return
  }
  await update($, readTop, () => 0)
  await update($, reading, () => ({ id: node.id, lines: bodyOf(text).split('\n') }))
}

const scrollReader = async ($: Host, by: number) => {
  const shown = await read($, reading)
  await update($, readTop, top =>
    Math.max(0, Math.min((shown?.lines.length ?? 1) - 1, top + by)),
  )
}

const dive = async ($: Host, id: string) => {
  await update($, trail, list => [...list, id])
  await update($, scrollX, () => 0)
  await moveTo($, nodeKey(id))
}

const goBack = async ($: Host) => {
  await update($, query, () => '')
  const shown = await update($, trail, list => list.slice(0, -1))
  await update($, scrollX, () => 0)
  const previous = shown.at(-1)
  if (previous) await moveTo($, nodeKey(previous))
  else await update($, cursor, () => '')
}

const openFile = async ($: Host, node: MapNode | undefined) => {
  const path = node?.paths[0]
  if (!path) {
    $.ui.toast('開くスキルを選んでください')
    return
  }
  try {
    const { exitCode } = await $.process.run(['open', path])
    if (exitCode !== 0) throw new Error(`exit ${exitCode}`)
    $.ui.toast(`開きました: ${path}`)
  } catch {
    $.ui.toast(`開けませんでした: ${path}`)
  }
}

/** 編集は Claude に依頼する。送る前に読めて、書き込みは通常の承認を通る。 */
const draft = async ($: Host, text: string) => {
  const { isFilled } = await $.prompt.fill({ text })
  if (!isFilled) {
    $.ui.toast('プロンプトに書き込めませんでした。入力中の内容や実行中のターンを確認してください')
    return
  }
  await $.ui.close({ id: PANE })
  $.ui.toast('プロンプトに下書きしました。内容を確認して送ってください')
}

const canEdit = ($: Host, node: MapNode) => {
  if (node.isEditable) return true
  $.ui.toast(`${node.name} は更新で上書きされるので編集できません`)
  return false
}

const repointText = (path: string, before: MapNode, after: MapNode) =>
  `${path} の中で ${refName(before)} を指している箇所を ${refName(after)} に付け替えてください。` +
  `手順の前提が変わる箇所も確認し、書き換える前に差分を見せてください。`

const removeText = (path: string, target: MapNode) =>
  `${path} から ${refName(target)} への参照を外してください。` +
  `手順がつながるように前後の文も直し、書き換える前に差分を見せてください。`

const addText = (path: string, target: MapNode) =>
  `${path} の適切な手順から ${refName(target)} を呼ぶようにしてください。` +
  `どこに入れるかを先に提案し、書き換える前に差分を見せてください。`

const combineText = (names: string[]) =>
  `次を順に呼ぶ新しいスキルを作ってください: ${names.join(' → ')}。` +
  `それぞれの入出力のつなぎ方と置き場所を先に提案してください。`

const startPicker = async ($: Host, from: MapNode, path: string, link?: MapLink) => {
  if (!canEdit($, from)) return

  await update($, query, () => '')
  await update($, picker, () => ({
    mode: link ? 'repoint' : 'add',
    from: from.id,
    path,
    ...(link ? { to: link.to } : {}),
  }))
  await moveTo($, 'filter')
}

const finishPick = async ($: Host, target: MapNode) => {
  const pick = await read($, picker)
  const map = await read($, graph)
  if (!pick) return

  await update($, picker, () => null)
  await update($, query, () => '')
  const before = map.nodes.find(one => one.id === pick.to)
  await draft(
    $,
    pick.mode === 'repoint' && before
      ? repointText(pick.path, before, target)
      : addText(pick.path, target),
  )
}

const repoint = async ($: Host, current: MapNode, row: Row | undefined) => {
  if (row?.kind !== 'node' || !row.link) {
    $.ui.toast('中心のスキルが呼んでいるノードを選んでください')
    return
  }
  await startPicker($, current, row.link.path, row.link)
}

const removeLink = async ($: Host, current: MapNode, row: Row | undefined) => {
  if (row?.kind !== 'node' || !row.link) {
    $.ui.toast('中心のスキルが呼んでいるノードを選んでください')
    return
  }
  if (canEdit($, current)) await draft($, removeText(row.link.path, row.node))
}

const toggleMark = async ($: Host, node: MapNode | undefined) => {
  if (!node) return
  await update($, marks, list =>
    list.includes(node.id) ? list.filter(one => one !== node.id) : [...list, node.id],
  )
}

const combine = async ($: Host) => {
  const map = await read($, graph)
  const nodes = (await read($, marks)).flatMap(id => {
    const node = map.nodes.find(one => one.id === id)
    return node ? [node] : []
  })
  if (nodes.length < 2) {
    $.ui.toast('m で 2 つ以上に印を付けてください')
    return
  }
  await update($, marks, () => [])
  await draft($, combineText(nodes.map(refName)))
}

/** 付け替えでは先頭の候補を選び、絞り込みでは結果の一覧へ移る。 */
const submitInput = async ($: Host, rows: Row[]) => {
  const first = rows.find(isRowTarget)
  if (await read($, picker)) {
    if (first?.kind === 'node') await finishPick($, first.node)
    return
  }
  await update($, isFiltering, () => false)
  if (first) await moveTo($, first.key)
}

const cancelInput = async ($: Host) => {
  await update($, reading, () => null)
  await update($, picker, () => null)
  await update($, isFiltering, () => false)
  await update($, query, () => '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'skillmap',
      description: 'スキルや plugin のつながりをペインで開く',
    })

    return next(e)
  })

  on('command.run', { command: 'skillmap' }, async $ => {
    await cancelInput($)
    await update($, trail, () => [])
    await update($, scrollX, () => 0)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    void scan($)

    return { text: 'スキルの地図を開きました。' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const isInput =
      (await read($, picker)) !== null ||
      (await read($, reading)) !== null ||
      (await read($, isFiltering))
    if (!isInput || e.origin.kind !== 'person') return next(e)

    await cancelInput($)
    return { deny: '入力を取り消しました' }
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const element = e.element ?? ''
    const isRow = element.startsWith('row:') || element.startsWith('group:')
    if (isRow) await update($, cursor, () => element)

    // 矢印キーがツールバーのボタンで止まらないよう、ノードの間だけを動かす。ボタンはキーで押せる。
    const isStray = element !== '' && !isRow && element !== 'filter'
    if (isStray && e.origin.kind === 'person' && (await read($, reading)) === null) return {}

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const map = await read($, graph)
    const info = await read($, plugins)
    const stack = await read($, trail)
    const open = await read($, openGroups)
    const marked = await read($, marks)
    const pick = await read($, picker)
    const text = await read($, query)
    const isFilter = await read($, isFiltering)
    const showHelp = await read($, isHelpOpen)
    const scanning = await read($, isScanning)
    const error = await read($, lastError)
    const current = await read($, cursor)

    const asList = await read($, isListView)
    const shownText = await read($, reading)
    const top = await read($, readTop)

    const focused = map.nodes.find(one => one.id === stack.at(-1))
    const columns = Math.max(40, e.props.bodyColumns - PANE_MARGIN)
    const overview = overviewBlocks(map, open)
    const showGraph = !pick && !isFilter && !text && (focused !== undefined || !asList)
    const blocks = !showGraph
      ? []
      : focused
        ? [focusBlock(map, focused.id)]
        : overview.blocks
    const offset = await read($, scrollX)
    const widest = Math.max(0, ...blocks.map(one => one.drawing.width))
    const leftRest = Math.min(offset, Math.max(0, widest - columns))
    const rightRest = Math.max(0, widest - columns - leftRest)
    const omittedCount = blocks.reduce((sum, one) => sum + one.omitted, 0)
    const rows = pick
      ? pickerRows(map, pick.from, text)
      : showGraph
        ? graphRows(map, blocks, focused?.id)
        : homeRows(map, info, open, text)
    const firstRow = rows.find(row => row.key === nodeKey(focused?.id ?? '')) ?? rows.find(isRowTarget)
    const selected = rows.find(row => row.key === current) ?? firstRow
    const selectedNode = selected?.kind === 'node' ? selected.node : focused
    const hasInput = pick !== null || isFilter
    const groupsShown = open.map(groupLabel).join('、')

    const nodeColor = (node: MapNode) =>
      marked.includes(node.id)
        ? 'yellow'
        : node.id === focused?.id
          ? 'green'
          : node.isEditable
            ? 'cyan'
            : undefined

    const press = (row: Row) => {
      if (row.kind === 'group') {
        return update($, openGroups, list =>
          row.isOpen ? list.filter(one => one !== row.group) : [...list, row.group],
        )
      }
      if (row.kind !== 'node') return undefined
      if (pick) return finishPick($, row.node)
      if (row.node.id === focused?.id) return openReader($, row.node)

      return (async () => {
        await update($, isFiltering, () => false)
        await update($, query, () => '')
        await dive($, row.node.id)
      })()
    }

    const counts = linkCounts(map)
    const detailNode = !hasInput && map.nodes.length > 0 && selected?.kind === 'node' ? selected.node : undefined
    const isDetailSpace = !hasInput && map.nodes.length > 0
    const peers = focused
      ? map.links.filter(one => one.from === focused.id || one.to === focused.id)
      : []
    const nameIn = nameOf(map)

    if (shownText) {
      const bodyRows = Math.max(5, e.props.scroll.bodyRows - READ_CHROME_ROWS)
      const shown = shownText.lines.slice(top, top + bodyRows)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Button key="read-back" label="戻る" plain hotkey="b" onPress={() => update($, reading, () => null)} />
            <Button key="read-down" label="下へ" plain hotkey="j" onPress={() => scrollReader($, READ_STEP)} />
            <Button key="read-up" label="上へ" plain hotkey="k" onPress={() => scrollReader($, -READ_STEP)} />
            <Button key="read-open" label="開く" plain hotkey="o" onPress={() => openFile($, focused)} />
            <Button key="read-close" label="閉じる" plain hotkey="q" dimColor onPress={() => $.ui.close({ id: PANE })} />
          </Box>
          <Text bold>
            {nameIn(shownText.id)}
            <Text dimColor>  {top + 1}/{shownText.lines.length} 行</Text>
          </Text>
          {shown.map(line => (
            <Text wrap="truncate">{solid(line || ' ')}</Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {!hasInput && (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {(focused || text) && <Button key="back" label="戻る" plain hotkey="b" onPress={() => goBack($)} />}
            {!focused && (
              <Button
                key="filter-start"
                label="絞り込み"
                plain
                hotkey="f"
                onPress={async () => {
                  await update($, isFiltering, () => true)
                  await moveTo($, 'filter')
                }}
              />
            )}
            {!focused && (
              <Button
                key="toggle-view"
                label={asList ? '表示: 一覧' : '表示: グラフ'}
                plain
                hotkey="t"
                onPress={async () => {
                  await update($, scrollX, () => 0)
                  await update($, isListView, value => !value)
                }}
              />
            )}
            <Button key="open-file" label="開く" plain hotkey="o" onPress={() => openFile($, selectedNode)} />
            {focused && (
              <>
                <Button key="repoint" label="付け替え" plain hotkey="r" onPress={() => repoint($, focused, selected)} />
                <Button key="remove" label="外す" plain hotkey="x" onPress={() => removeLink($, focused, selected)} />
                <Button
                  key="add"
                  label="つなぐ"
                  plain
                  hotkey="a"
                  onPress={() => startPicker($, focused, focused.paths[0] ?? '')}
                />
              </>
            )}
            <Button key="mark" label="印" plain hotkey="m" onPress={() => toggleMark($, selectedNode)} />
            <Button
              key="combine"
              label={`組み合わせ（${marked.length}）`}
              plain
              hotkey="c"
              onPress={() => combine($)}
            />
            <Button key="rescan" label="読み直す" plain hotkey="u" dimColor onPress={() => scan($)} />
            <Button
              key="help"
              label="キー一覧"
              plain
              hotkey="i"
              dimColor
              onPress={() => update($, isHelpOpen, value => !value)}
            />
            <Button key="close" label="閉じる" plain hotkey="q" dimColor onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        )}
        {showHelp && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {KEY_HELP.map(([keys, action]) => (
              <Text>
                <Text bold>{(keys ?? '').padEnd(8)}</Text> {action}
              </Text>
            ))}
          </Box>
        )}
        {error && <Text color="red">読み込みエラー: {error}</Text>}
        {map.nodes.length === 0 && !error && <Text dimColor>読み込み中…</Text>}
        {hasInput && (
          <Input
            key="filter"
            label={pick ? (pick.mode === 'repoint' ? '付け替え先: ' : 'つなぐ先: ') : '絞り込み: '}
            placeholder="名前や説明で探す（Esc で取り消し）"
            value={text}
            submitLabel={pick ? '先頭を選ぶ' : '決定'}
            autoFocus
            onInput={value => void update($, query, () => value)}
            onSubmit={() => submitInput($, rows)}
          />
        )}
        {focused && !pick && (
          <Text bold>{stack.map(id => id.split('/').pop()).join(' › ')}</Text>
        )}
        {isDetailSpace && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text wrap="truncate">
              <Text bold>{detailNode?.name ?? ' '}</Text>
              {detailNode && (
                <Text dimColor>
                  {'  '}
                  {groupLabel(detailNode.group)} · {detailNode.kinds.join(' + ')} · {countText(counts.of(detailNode.id))}
                  {detailNode.isEditable ? '' : ' · 読み取り専用'}
                </Text>
              )}
            </Text>
            {wrapLines(detailNode?.description || '説明はありません', columns - DETAIL_FRAME, DESCRIPTION_LINES).map(line => (
              <Text>{solid(line || ' ')}</Text>
            ))}
            <Text dimColor wrap="truncate">{(selected?.kind === 'node' && selected.note) || ' '}</Text>
          </Box>
        )}
        {showGraph && map.nodes.length > 0 && !focused && (
          <Text dimColor>表示中: {groupsShown}（t の一覧でグループを開くと増えます）</Text>
        )}
        {showGraph && blocks.map(block => (
          <Box key={block.key} flexDirection="column" marginTop={1}>
            {block.drawing.lines.map((line, index) => [line, index] as const).map(([line, index]) => (
              <Box key={`${block.key}:${index}`} flexDirection="row">
                {sliceLine(line, leftOf(block, offset, columns), columns).map(segment => {
                  const row = rows.find(one => one.key === nodeKey(segment.nodeId ?? ''))
                  if (row?.kind !== 'node') {
                    return <Text dimColor wrap="truncate">{solid(segment.text)}</Text>
                  }
                  const color = nodeColor(row.node)

                  return (
                    <Button
                      key={row.key}
                      label={row.text}
                      plain
                      autoFocus={!hasInput && row === firstRow ? true : undefined}
                      onPress={() => press(row)}
                    >
                      <Text
                        wrap="truncate"
                        bold={row.node.id === focused?.id || row === selected}
                        underline={row === selected}
                        color={color}
                        dimColor={color === undefined}
                      >
                        {solid(segment.text)}
                      </Text>
                    </Button>
                  )
                })}
              </Box>
            ))}
          </Box>
        ))}
        {showGraph && map.nodes.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>─▶ 呼ぶ  ◀▶ 相互に参照  ─◀ 右から左へ呼ぶ（循環）</Text>
            {widest > columns && (
              <Text dimColor>
                h l で横にスクロール: {leftRest > 0 ? `◀ 左にあと ${leftRest} 列` : '左端'} / {rightRest > 0 ? `右にあと ${rightRest} 列 ▶` : '右端'}
              </Text>
            )}
            {omittedCount > 0 && <Text dimColor>読みやすくするため線を {omittedCount} 本省略</Text>}
            {!focused && overview.isolated > 0 && (
              <Text dimColor>つながりのないスキルは {overview.isolated} 件（t の一覧で見られます）</Text>
            )}
          </Box>
        )}
        {showGraph && focused && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>つながりの詳細</Text>
            {peers.length === 0 && <Text dimColor>つながりはありません</Text>}
            {peers.map(link => {
              const isOut = link.from === focused.id

              return (
                <Text dimColor wrap="truncate">
                  {isOut ? '→ ' : '← '}
                  {nameIn(isOut ? link.to : link.from)}  L{link.line} ×{link.count}  {link.excerpt}
                </Text>
              )
            })}
            <Text bold>ファイル</Text>
            {focused.paths.map(path => (
              <Text dimColor wrap="truncate">{path}</Text>
            ))}
          </Box>
        )}
        {!showGraph && rows.map(row => {
          if (row.kind === 'label') return <Text bold>{row.text}</Text>

          const isMarked = row.kind === 'node' && marked.includes(row.node.id)

          return (
            <Button
              key={row.key}
              label={row.text}
              plain
              autoFocus={!hasInput && row === firstRow ? true : undefined}
              onPress={() => press(row)}
            >
              <Text bold={row.kind === 'group'} color={isMarked ? 'yellow' : undefined}>
                {isMarked ? '● ' : ''}
                {row.text}
              </Text>
              {row.note && <Text dimColor>  {row.note}</Text>}
            </Button>
          )
        })}
        {!hasInput && (
          <Box flexDirection="row" gap={2}>
            <Button key="move-down" label="下へ" plain hotkey="j" dimColor onPress={() => moveCursor($, rows, selected?.key, blocks, columns, 1)} />
            <Button key="move-up" label="上へ" plain hotkey="k" dimColor onPress={() => moveCursor($, rows, selected?.key, blocks, columns, -1)} />
            <Button key="move-left" label="左へ" plain hotkey="h" dimColor onPress={() => moveSide($, selected?.key, blocks, columns, -1)} />
            <Button key="move-right" label="右へ" plain hotkey="l" dimColor onPress={() => moveSide($, selected?.key, blocks, columns, 1)} />
          </Box>
        )}
        {scanning && map.nodes.length > 0 && <Text dimColor>読み直し中…</Text>}
      </Box>
    )
  })
}
