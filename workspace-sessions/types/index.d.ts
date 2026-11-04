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

/** 表示ペインに並べる 1 発言。ツールの呼び出しは含めない */
export type WsTurn = {
  role: 'you' | 'claude'
  text: string
}

export type WsConvo = {
  sessionId: string
  isLoading?: boolean
  turns: WsTurn[]
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
      /** 表示ペインで見ているセッション。o / i で入り、Esc / q で一覧へ戻ると消す */
      viewing: Shaped<WsSession | null>
      /** 表示ペインの会話 */
      convo: Shaped<WsConvo | null>
      /** 表示ペインに送る欄を出しているか */
      composing: boolean
    }
  }
}
