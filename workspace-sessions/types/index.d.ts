/** どこから来たセッションか: バックグラウンド・端末で対話・過去のトランスクリプト */
export type WsKind = 'background' | 'interactive' | 'past'

export type WsSession = {
  sessionId: string
  /** `claude attach` が受け取る短い id (バックグラウンドだけ) */
  shortId?: string
  name: string
  cwd: string
  /** ワークスペースの根から見た場所。根そのものは '' */
  place: string
  kind: WsKind
  /** 動いているプロセスの様子 (busy / idle)。止まっていれば無し */
  status?: string
  /** バックグラウンドの仕事の様子 (working / done / blocked) */
  state?: string
  isRunning: boolean
  isSelf: boolean
  /** 最後に動いた時刻 (ms) */
  at: number
  transcript?: string
  webUrl?: string
}

export type WsSnapshot = {
  root: string
  label: string
  sessions: WsSession[]
  loadedAt: number
  error?: string
}

export type WsPeek = {
  sessionId: string
  isLoading?: boolean
  prompt?: string
  reply?: string
  /** 最後の依頼のあとに返答が来ているか */
  isAnswered?: boolean
  at?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'workspace-sessions': {
      snapshot: Shaped<WsSnapshot | null>
      isLoading: boolean
      selected: string | null
      peek: Shaped<WsPeek | null>
      showAll: boolean
      sent: number
      /** 詳細 (最後の依頼と返答) を開いているか。d で切り替え、移動しても保つ */
      showDetail: boolean
      /** 送る欄を出しているセッション。Enter / i で出し、移動か送信で消す */
      typing: string | null
    }
  }
}
