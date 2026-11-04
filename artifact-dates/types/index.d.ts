export type ShelfScope = 'mine' | 'shared'

export type Item = {
  url: string
  title: string
  /** YYYY-MM-DD。共有分には無い */
  updated?: string
  isPinned: boolean
}

export type Listing = {
  items: Item[]
  loadedAt: number
  error?: string
}

/** Artifact を最初に公開した会話 */
export type Origin = { sessionId: string; root: string; project: string; day: string }

export type Origins = Record<string, Origin>

export type PreviewLine = { text: string; isHeading: boolean }

export type Preview = { lines: PreviewLine[]; error?: string }

export type Previews = Record<string, Preview>

export type Lists = Partial<Record<ShelfScope, Listing>>

declare module 'claude-code' {
  interface PluginState {
    'artifact-dates': {
      scope: ShelfScope
      lists: Shaped<Lists>
      isLoading: boolean
      /** 選んでいる Artifact の URL */
      selected: string | null
      filter: string
      isFiltering: boolean
      previews: Shaped<Previews>
      origins: Shaped<Origins>
      /** いま本文を読んでいる URL */
      previewing: string | null
      showPreview: boolean
    }
  }
}
