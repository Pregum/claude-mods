import type { MapLink, MapNode, SkillGraph, SourceFile } from '../types'

const TOKEN = /(?<![\w./@<-])(\/?)(?:([a-z0-9][a-z0-9-]*):)?([a-z0-9][a-z0-9-]*)(?![\w-])/g
const SKILL_PATH = /(?:^|[/\s`"'(])skills\/([a-z0-9][a-z0-9-]*)\//g
const KIND_WORD = /^\s*(?:スキル|サブエージェント|エージェント|コマンド|skill|subagent|agent|command)/i
const SYNCED_NAMESPACE = 'anthropic-skills'
const EXCERPT_LENGTH = 80

const isEditableGroup = (group: string) => group === 'project' || group === 'user'

const nodeId = (group: string, name: string) => `${group}/${name}`

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/

/** frontmatter を除いた本文。 */
export const bodyOf = (text: string) => text.replace(FRONT_MATTER, '').trim()

/** frontmatter の description。無ければ本文の最初の文を説明にする。 */
const describe = (text: string) => {
  const head = FRONT_MATTER.exec(text)?.[1] ?? ''
  const lines = head.split('\n')
  const at = lines.findIndex(line => line.startsWith('description:'))
  const first = at < 0 ? '' : (lines[at] ?? '').slice('description:'.length).trim()
  if (first && !/^[>|][+-]?$/.test(first)) return first.replace(/^["']|["']$/g, '')
  if (at >= 0) {
    const rest = lines.slice(at + 1)
    const end = rest.findIndex(line => !/^\s/.test(line) && line !== '')
    const block = (end < 0 ? rest : rest.slice(0, end)).join(' ').trim()
    if (block) return block
  }

  return (
    bodyOf(text)
      .split('\n')
      .map(line => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  )
}

const mergeNodes = (files: SourceFile[]) => {
  const nodes = new Map<string, MapNode>()
  for (const file of files) {
    const id = nodeId(file.group, file.name)
    const known = nodes.get(id)
    if (!known) {
      nodes.set(id, {
        id,
        name: file.name,
        group: file.group,
        kinds: [file.kind],
        paths: [file.path],
        description: describe(file.text),
        isEditable: isEditableGroup(file.group),
      })
      continue
    }
    known.paths.push(file.path)
    known.description ||= describe(file.text)
    if (!known.kinds.includes(file.kind)) known.kinds.push(file.kind)
  }

  return nodes
}

/** 同じ出どころを先に探す。plugin 同士の同名は決められないので繋がない。 */
const resolve = (
  nodes: Map<string, MapNode>,
  fromGroup: string,
  namespace: string | undefined,
  name: string,
) => {
  if (namespace) {
    const group = namespace === SYNCED_NAMESPACE ? 'synced' : `plugin:${namespace}`
    return (
      nodes.get(nodeId(group, name)) ??
      // サブフォルダのコマンドは /フォルダ:名前 で呼ぶ
      [fromGroup, 'project', 'user']
        .map(one => nodes.get(nodeId(one, `${namespace}:${name}`)))
        .find(Boolean)
    )
  }
  for (const group of [fromGroup, 'project', 'user', 'synced']) {
    const found = nodes.get(nodeId(group, name))
    if (found) return found
  }
  const inPlugins = [...nodes.values()].filter(
    one => one.name === name && one.group.startsWith('plugin:'),
  )

  return inPlugins.length === 1 ? inPlugins[0] : undefined
}

const lineAt = (text: string, index: number) => {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  return {
    line: text.slice(0, index).split('\n').length,
    excerpt: text
      .slice(start, end < 0 ? undefined : end)
      .trim()
      .slice(0, EXCERPT_LENGTH),
  }
}

/** ハイフンのない一語は普通の単語と区別できないので、呼び方が明らかなときだけ参照とみなす。 */
const isMention = (text: string, end: number, name: string, slash: string, namespace?: string) => {
  const next = text.slice(end, end + 2)
  if (next[0] === '/' || /^\.[\w]/.test(next)) return false
  if (namespace || name.includes('-')) return true

  return slash !== '' || KIND_WORD.test(text.slice(end, end + 16))
}

export const buildGraph = (files: SourceFile[], builtins: Set<string>): SkillGraph => {
  const nodes = mergeNodes(files)
  const links = new Map<string, MapLink>()

  const record = (file: SourceFile, to: MapNode, index: number, isPath: boolean) => {
    const from = nodeId(file.group, file.name)
    if (to.id === from) return

    const key = `${from}>${to.id}`
    const known = links.get(key)
    if (known) {
      known.count += 1
      known.isPathOnly &&= isPath
      return
    }
    links.set(key, {
      from,
      to: to.id,
      path: file.path,
      count: 1,
      isPathOnly: isPath,
      ...lineAt(file.text, index),
    })
  }

  for (const file of files) {
    for (const match of file.text.matchAll(TOKEN)) {
      const [whole, slash = '', namespace, name = ''] = match
      const end = match.index + whole.length
      if (!isMention(file.text, end, name, slash, namespace)) continue
      if (!namespace && builtins.has(name)) continue

      const target = resolve(nodes, file.group, namespace, name)
      if (target) record(file, target, match.index, false)
    }
    for (const match of file.text.matchAll(SKILL_PATH)) {
      const target = resolve(nodes, file.group, undefined, match[1] ?? '')
      if (target) record(file, target, match.index, true)
    }
  }

  return { nodes: [...nodes.values()], links: [...links.values()] }
}

/** プロンプトに書くときの呼び名。 */
export const refName = (node: MapNode) =>
  node.group.startsWith('plugin:')
    ? `${node.group.slice('plugin:'.length)}:${node.name}`
    : node.name
