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

declare module 'claude-code' {
  interface PluginState {
    'where-now': {
      /** いまのターンの依頼 */
      ask: string
      tasks: Shaped<WnTask[]>
      /** このターンで触ったファイル。最後に触ったものが先頭 */
      files: Shaped<WnFile[]>
    }
  }
}
