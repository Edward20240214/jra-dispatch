export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      windows: UsageWindow[] | null
      // 枠ごとに、残量が通知のしきい値を下回ったことをすでに知らせたか
      alerted: Record<string, boolean>
    }
  }
}
