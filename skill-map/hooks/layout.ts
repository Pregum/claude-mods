/** 有向グラフを左から右への段に並べ、罫線の文字で描く。 */

export type GraphEdge = { from: string; to: string }

export type Segment = { text: string; nodeId?: string; isLine?: boolean }

export type Place = { id: string; layer: number; row: number; x: number; width: number }

export type Drawing = {
  lines: Segment[][]
  /** 上から順のノード。カーソル移動に使う */
  nodeIds: string[]
  /** 各ノードの段・行・横位置。左右の移動とスクロールに使う */
  places: Place[]
  /** 図全体の幅 */
  width: number
}

type DrawnEdge = GraphEdge & { isBoth: boolean; isFlipped: boolean }
type Piece = { from: string; to: string; edge: DrawnEdge; isLast: boolean }

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8
const BOX: Record<number, string> = {
  0: ' ', 1: '│', 2: '│', 3: '│', 4: '─', 8: '─', 12: '─',
  5: '┘', 6: '┐', 7: '┤', 9: '└', 10: '┌', 11: '├', 13: '┴', 14: '┬', 15: '┼',
}
const MAX_LABEL = 26
const SWEEPS = 4
const TRACK_WIDTH = 2
const ARROW_WIDTH = 2
const DUMMY = 'dummy:'

const isWide = (ch: string) =>
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)

export const cells = (text: string) => [...text].reduce((sum, ch) => sum + (isWide(ch) ? 2 : 1), 0)

const fit = (text: string, width: number) => {
  if (cells(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) >= width) break
    out += ch
  }
  return `${out}…`
}

/** 相互参照は 1 本にまとめる。 */
const mergePairs = (edges: GraphEdge[]) => {
  const merged = new Map<string, DrawnEdge>()
  for (const { from, to } of edges) {
    if (from === to || merged.has(`${from}>${to}`)) continue
    const reverse = merged.get(`${to}>${from}`)
    if (reverse) reverse.isBoth = true
    else merged.set(`${from}>${to}`, { from, to, isBoth: false, isFlipped: false })
  }

  return [...merged.values()]
}

/** 循環を切る。戻る辺は向きを反転して並べ、描くときに逆向きの矢印にする。 */
const breakCycles = (ids: string[], edges: DrawnEdge[]) => {
  const outgoing = new Map<string, DrawnEdge[]>(ids.map(id => [id, []]))
  for (const edge of edges) outgoing.get(edge.from)?.push(edge)

  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string) => {
    state.set(id, 'open')
    for (const edge of outgoing.get(id) ?? []) {
      const seen = state.get(edge.to)
      if (seen === 'open') edge.isFlipped = true
      else if (!seen) visit(edge.to)
    }
    state.set(id, 'done')
  }
  for (const id of ids) if (!state.has(id)) visit(id)

  return edges.map(edge =>
    edge.isFlipped ? { ...edge, from: edge.to, to: edge.from } : edge,
  )
}

const assignLayers = (ids: string[], edges: DrawnEdge[]) => {
  const layer = new Map(ids.map(id => [id, 0]))
  for (let pass = 0; pass < ids.length; pass += 1) {
    let isChanged = false
    for (const { from, to } of edges) {
      const next = (layer.get(from) ?? 0) + 1
      if (next > (layer.get(to) ?? 0)) {
        layer.set(to, next)
        isChanged = true
      }
    }
    if (!isChanged) break
  }

  return layer
}

/** 2 段以上またぐ辺は、途中の段に通過点を置いて 1 段ずつの線に分ける。 */
const splitLongEdges = (edges: DrawnEdge[], layer: Map<string, number>) => {
  const pieces: Piece[] = []
  let serial = 0
  for (const edge of edges) {
    const start = layer.get(edge.from) ?? 0
    const end = layer.get(edge.to) ?? 0
    let previous = edge.from
    for (let at = start + 1; at < end; at += 1) {
      const dummy = `${DUMMY}${serial}`
      serial += 1
      layer.set(dummy, at)
      pieces.push({ from: previous, to: dummy, edge, isLast: false })
      previous = dummy
    }
    pieces.push({ from: previous, to: edge.to, edge, isLast: true })
  }

  return pieces
}

const average = (values: number[]) =>
  values.reduce((sum, one) => sum + one, 0) / values.length

/** 隣の段に近い順へ並べ替えて、線の交差を減らす。 */
const orderLayers = (layers: string[][], pieces: Piece[]) => {
  const place = new Map<string, number>()
  const remember = () =>
    layers.forEach(list => list.forEach((id, index) => place.set(id, index)))
  remember()

  const neighbours = (id: string, isForward: boolean) =>
    pieces.flatMap(one => {
      const other = isForward
        ? one.to === id ? one.from : undefined
        : one.from === id ? one.to : undefined
      const at = other === undefined ? undefined : place.get(other)
      return at === undefined ? [] : [at]
    })

  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const isForward = sweep % 2 === 0
    const order = layers.map((_, index) => index)
    for (const index of isForward ? order : order.reverse()) {
      const list = layers[index] ?? []
      const keyOf = (id: string) => {
        const near = neighbours(id, isForward)
        return near.length > 0 ? average(near) : (place.get(id) ?? 0)
      }
      const keys = new Map(list.map(id => [id, keyOf(id)]))
      list.sort((a, b) => (keys.get(a) ?? 0) - (keys.get(b) ?? 0))
      remember()
    }
  }
}

/** 縦の位置。つながる相手の高さに寄せ、同じ段では重ならないようにする。 */
const assignRows = (layers: string[][], pieces: Piece[]) => {
  const row = new Map<string, number>()
  layers.forEach(list => list.forEach((id, index) => row.set(id, index)))

  const align = (list: string[], isForward: boolean) => {
    let lowest = -1
    for (const id of list) {
      const near = pieces.flatMap(one => {
        const other = isForward
          ? one.to === id ? one.from : undefined
          : one.from === id ? one.to : undefined
        const at = other === undefined ? undefined : row.get(other)
        return at === undefined ? [] : [at]
      })
      const wanted = near.length > 0 ? Math.round(average(near)) : (row.get(id) ?? 0)
      lowest = Math.max(wanted, lowest + 1)
      row.set(id, lowest)
    }
  }
  for (const list of layers.slice(1)) align(list, true)
  for (const list of layers.slice(0, -1).reverse()) align(list, false)

  return row
}

type Gutter = { width: number; grid: Map<string, number>; heads: Map<number, string> }

/** 段の間の線。同じノードから出る線は 1 本の縦線を共有する。 */
const routeGutter = (pieces: Piece[], row: Map<string, number>): Gutter => {
  const groups = new Map<string, Piece[]>()
  for (const piece of pieces) {
    groups.set(piece.from, [...(groups.get(piece.from) ?? []), piece])
  }
  const spans = [...groups.values()].map(list => {
    const ys = [list[0]?.from, ...list.map(one => one.to)].map(id => row.get(id ?? '') ?? 0)
    return { list, top: Math.min(...ys), bottom: Math.max(...ys) }
  })
  spans.sort((a, b) => a.top - b.top || b.bottom - a.bottom)

  const trackEnds: number[] = []
  const placed = spans.map(span => {
    const isStraight = span.top === span.bottom
    if (isStraight) return { ...span, track: -1 }
    const free = trackEnds.findIndex(end => end < span.top)
    const track = free < 0 ? trackEnds.length : free
    trackEnds[track] = span.bottom
    return { ...span, track }
  })

  const width = 1 + Math.max(1, trackEnds.length) * TRACK_WIDTH + ARROW_WIDTH
  const grid = new Map<string, number>()
  const heads = new Map<number, string>()
  const mark = (y: number, x: number, bits: number) => {
    const key = `${y}:${x}`
    grid.set(key, (grid.get(key) ?? 0) | bits)
  }
  const horizontal = (y: number, start: number, end: number) => {
    for (let x = start; x <= end; x += 1) {
      mark(y, x, (x > start ? LEFT : 0) | (x < end ? RIGHT : 0))
    }
  }

  for (const { list, track } of placed) {
    const startY = row.get(list[0]?.from ?? '') ?? 0
    const x = track < 0 ? 0 : 1 + track * TRACK_WIDTH
    horizontal(startY, 0, Math.max(x, 0))
    for (const piece of list) {
      const endY = row.get(piece.to) ?? 0
      horizontal(endY, x, width - 1)
      for (let y = Math.min(startY, endY); y <= Math.max(startY, endY); y += 1) {
        if (startY === endY) break
        mark(y, x, (y > Math.min(startY, endY) ? UP : 0) | (y < Math.max(startY, endY) ? DOWN : 0))
      }
      if (piece.isLast) {
        const head = piece.edge.isBoth ? '◀▶' : piece.edge.isFlipped ? '─◀' : '─▶'
        const known = heads.get(endY)
        // 同じノードに入る線と出る線が重なるときは両方向で見せる
        heads.set(endY, known === undefined || known === head ? head : '◀▶')
      }
    }
  }

  return { width, grid, heads }
}

const gutterRow = (gutter: Gutter, y: number) => {
  let text = ''
  for (let x = 0; x < gutter.width; x += 1) {
    text += BOX[gutter.grid.get(`${y}:${x}`) ?? 0] ?? ' '
  }
  const head = gutter.heads.get(y)

  return head ? text.slice(0, -ARROW_WIDTH) + head : text
}

const totalWidth = (labels: number[], gutters: Gutter[]) =>
  labels.reduce((sum, one) => sum + one, 0) +
  gutters.reduce((sum, one) => sum + one.width, 0)

/**
 * ids の順を優先して段に並べる。先頭に近いノードが左へ寄るので、
 * 循環があるときは中心のノードを先に渡す。
 */
export const drawGraph = (
  ids: string[],
  edges: GraphEdge[],
  labelOf: (id: string) => string,
): Drawing => {
  const drawn = breakCycles(ids, mergePairs(edges))
  const layerOf = assignLayers(ids, drawn)
  const pieces = splitLongEdges(drawn, layerOf)

  const depth = Math.max(0, ...layerOf.values())
  const layers: string[][] = Array.from({ length: depth + 1 }, () => [])
  for (const [id, at] of layerOf) layers[at]?.push(id)
  orderLayers(layers, pieces)
  const row = assignRows(layers, pieces)

  const routeBetween = (index: number) => {
    const left = new Set(layers[index])
    return routeGutter(pieces.filter(one => left.has(one.from)), row)
  }
  const labelText = (id: string) => `[${fit(labelOf(id), MAX_LABEL)}]`
  const labels = layers.map(list =>
    Math.max(1, ...list.filter(id => !id.startsWith(DUMMY)).map(id => cells(labelText(id)))),
  )
  const gutters = layers.slice(0, -1).map((_, index) => routeBetween(index))
  const lefts = layers.map((_, index) =>
    totalWidth(labels.slice(0, index), gutters.slice(0, index)),
  )

  const placed = new Map<number, Map<number, string>>()
  for (const list of layers) {
    for (const id of list) {
      const y = row.get(id) ?? 0
      const atRow = placed.get(y) ?? new Map<number, string>()
      atRow.set(layerOf.get(id) ?? 0, id)
      placed.set(y, atRow)
    }
  }

  const height = Math.max(0, ...[...row.values()]) + 1
  const lines: Segment[][] = []
  const nodeIds: string[] = []
  const places: Place[] = []
  for (let y = 0; y < height; y += 1) {
    const atRow = placed.get(y)
    const segments: Segment[] = []
    const add = (text: string) => {
      const last = segments.at(-1)
      if (last && last.nodeId === undefined) last.text += text
      else segments.push({ text })
    }
    layers.forEach((_, index) => {
      const id = atRow?.get(index)
      const width = labels[index] ?? 0
      if (id && !id.startsWith(DUMMY)) {
        const text = labelText(id)
        segments.push({ text, nodeId: id })
        nodeIds.push(id)
        places.push({ id, layer: index, row: y, x: lefts[index] ?? 0, width: cells(text) })
        const hasOut = gutters[index]?.grid.has(`${y}:0`) ?? false
        add((hasOut ? '─' : ' ').repeat(width - cells(text)))
      } else {
        add((id ? '─' : ' ').repeat(width))
      }
      const gutter = gutters[index]
      if (gutter) add(gutterRow(gutter, y))
    })
    if (segments.some(one => one.nodeId !== undefined || one.text.trim() !== '')) {
      lines.push(segments.map(one => ({
        ...one,
        ...(one.nodeId === undefined ? { isLine: true } : {}),
      })))
    }
  }

  return { lines, nodeIds, places, width: totalWidth(labels, gutters) }
}

/** つながっている塊ごとに分ける。大きい順。 */
export const components = (ids: string[], edges: GraphEdge[]) => {
  const parent = new Map(ids.map(id => [id, id]))
  const root = (id: string): string => {
    const up = parent.get(id) ?? id
    return up === id ? id : root(up)
  }
  for (const { from, to } of edges) {
    if (parent.has(from) && parent.has(to)) parent.set(root(from), root(to))
  }
  const groups = new Map<string, string[]>()
  for (const id of ids) groups.set(root(id), [...(groups.get(root(id)) ?? []), id])

  return [...groups.values()].sort((a, b) => b.length - a.length)
}

/** 根から幅優先でたどった木の辺だけを残す。線が多い図を読めるようにする。 */
export const treeEdges = (roots: string[], edges: GraphEdge[], maxDepth = Infinity) => {
  const seen = new Set(roots)
  const kept: GraphEdge[] = []
  let frontier = roots
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const edge of edges) {
        if (edge.from !== id || seen.has(edge.to)) continue
        seen.add(edge.to)
        kept.push(edge)
        next.push(edge.to)
      }
    }
    frontier = next
  }

  return kept
}

/** 隣の段で、高さが一番近いノード。 */
export const pickSide = (places: Place[], current: string, by: number) => {
  const at = places.find(one => one.id === current)
  if (!at) return undefined

  const side = places.filter(one => one.layer === at.layer + by)
  const distance = (one: Place) => Math.abs(one.row - at.row)

  return [...side].sort((a, b) => distance(a) - distance(b))[0]?.id
}

/** 決まった行数に折り返す。行数が変わると図が動くので、足りない分は空行で埋める。 */
export const wrapLines = (text: string, width: number, count: number) => {
  const lines: string[] = []
  let line = ''
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    if (cells(line + ch) > width) {
      lines.push(line)
      line = ''
    }
    line += ch
  }
  if (line) lines.push(line)

  const kept = lines.slice(0, count)
  if (lines.length > count) kept[count - 1] = `${(kept[count - 1] ?? '').slice(0, -2)}…`

  return [...kept, ...Array.from({ length: count - kept.length }, () => '')]
}

/** 横スクロールの窓に入る部分だけを切り出す。 */
export const sliceLine = (line: Segment[], left: number, width: number) => {
  const shown: Segment[] = []
  let column = 0
  for (const segment of line) {
    let text = ''
    for (const ch of segment.text) {
      const size = cells(ch)
      if (column >= left && column + size <= left + width) text += ch
      column += size
    }
    if (text) shown.push({ ...segment, text })
  }

  return shown
}
