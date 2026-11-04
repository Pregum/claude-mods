export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type WnTask = {
  /** TodoWrite の項目には id が無いので、並び順を使う */
  id: string
  text: string
  /** 進行中に出す言い方 ("テストを実行中") */
  activeForm?: string
  status: TaskStatus
}

export type WnFile = {
  path: string
  reads: number
  writes: number
  /** いま動いている呼び出しの数 */
  running: number
  failed: number
  /** サブエージェントだけが触ったか */
  isSubOnly: boolean
}

/** 依頼で主に何をしたか */
export type TurnKind = 'edit' | 'run' | 'read' | 'agent' | 'mcp' | 'talk'

/** ツールの呼び出し数の内訳 */
export type WnTools = { edit: number; run: number; read: number; agent: number; mcp: number }

/** 名前ごとの回数。多い順に持つ */
export type WnCount = { name: string; count: number }

export type WnTurn = {
  /** 依頼の行の id。トランスクリプトから引けなければ無し */
  id?: string
  text: string
  kind: TurnKind
  tools: WnTools
  /** 使ったツール。MCP は servers に分ける */
  names: WnCount[]
  /** 使った MCP サーバー */
  servers: WnCount[]
  /** Write / Edit / NotebookEdit で編集したファイル */
  edits: WnCount[]
  /** 依頼 1 + ツールの呼び出し数 */
  weight: number
}

/** セッション全体の長さ */
export type WnMap = {
  turns: WnTurn[]
  startedAt: number
  /** コンテキストウィンドウの使用率。最初の返答までは無し */
  percent?: number
  /** 使用トークン数と、自動 compact が走るトークン数。自動 compact が切れていれば無し */
  compact?: { tokens: number; threshold: number }
}

declare module 'claude-code' {
  interface PluginState {
    'where-now': {
      tasks: Shaped<WnTask[]>
      /** このターンで触ったファイル。最後に触ったものが先頭 */
      files: Shaped<WnFile[]>
      map: Shaped<WnMap | null>
      /** マップで選んでいる依頼の番号。null はいまの依頼 */
      picked: number | null
    }
  }
}
