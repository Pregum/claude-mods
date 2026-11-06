export type SourceFile = {
  kind: 'skill' | 'command' | 'agent'
  /** 'project' | 'user' | 'synced' | 'plugin:<名前>' */
  group: string
  name: string
  path: string
  text: string
}

export type MapNode = {
  id: string
  name: string
  group: string
  kinds: string[]
  paths: string[]
  description: string
  /** plugin と同期スキルは更新で上書きされるので編集しない */
  isEditable: boolean
}

export type MapLink = {
  from: string
  to: string
  /** 参照が書かれているファイル */
  path: string
  count: number
  line: number
  excerpt: string
  /** skills/<name>/ のようなファイルパスでだけ参照している */
  isPathOnly: boolean
}

export type SkillGraph = { nodes: MapNode[]; links: MapLink[] }

export type PluginInfo = {
  group: string
  isEnabled: boolean
  hasHooks: boolean
  hasMcp: boolean
}

export type Reading = { id: string; lines: string[] }

export type Picker = {
  mode: 'repoint' | 'add'
  from: string
  /** 付け替え前のつなぎ先 */
  to?: string
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    'skill-map': {
      graph: Shaped<SkillGraph>
      plugins: Shaped<PluginInfo[]>
      trail: Shaped<string[]>
      openGroups: Shaped<string[]>
      marks: Shaped<string[]>
      picker: Shaped<Picker | null>
      reading: Shaped<Reading | null>
      readTop: number
      scrollX: number
      cursor: string
      query: string
      isFiltering: boolean
      isHelpOpen: boolean
      isListView: boolean
      isScanning: boolean
      error: string
    }
  }
}
