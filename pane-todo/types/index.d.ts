export type TodoTab = 'today' | 'active' | 'focus' | 'ideas'

export type Todo = {
  id: string
  title: string
  source?: string
  notes?: string
  due?: string
  url?: string
}

export type TodoList = {
  tasks: Todo[]
  count: number
  loadedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pane-todo': {
      tab: TodoTab
      list: Shaped<TodoList | null>
      isLoading: boolean
      /** 選んでいる Todo の id */
      selected: string | null
      /** 追加の入力欄を出しているか */
      composing: boolean
      /** 選んでいる Todo のメモを出しているか */
      showNotes: boolean
      /** 最後に完了した Todo の id。u で戻す */
      lastDone: string | null
    }
  }
}
