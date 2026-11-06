export type CalEvent = {
  id: string
  title: string
  /** 終日は YYYY-MM-DD、時刻つきは ISO 8601 */
  start: string
  end: string
  isAllDay: boolean
  /** 会議に参加する URL（許可した会議サービスのみ） */
  url?: string
}

declare module 'claude-code' {
  interface PluginState {
    'calendar-peek': {
      events: Shaped<CalEvent[]>
      now: number
      days: number
      cursor: string
      isHelpOpen: boolean
      fetchedAt: number
      error: string
    }
  }
}
