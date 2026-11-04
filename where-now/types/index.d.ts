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
export type TurnKind = 'edit' | 'run' | 'read' | 'agent' | 'talk'

export type WnTurn = {
  /** 依頼の行の id。トランスクリプトから引けなければ無し */
  id?: string
  text: string
  kind: TurnKind
  /** 依頼 1 + ツールの呼び出し数 */
  weight: number
}

/** セッション全体の長さ */
export type WnMap = {
  turns: WnTurn[]
  startedAt: number
  /** コンテキストの使用率。最初の返答までは無し */
  percent?: number
}

declare module 'claude-code' {
  interface PluginState {
    'where-now': {
      /** いまのターンの依頼 */
      ask: string
      tasks: Shaped<WnTask[]>
      /** このターンで触ったファイル。最後に触ったものが先頭 */
      files: Shaped<WnFile[]>
      map: Shaped<WnMap | null>
      /** マップで選んでいる依頼の番号。null はいまの依頼 */
      picked: number | null
    }
  }
}
