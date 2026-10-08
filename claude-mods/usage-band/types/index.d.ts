export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      windows: UsageWindow[] | null
      // 枠ごとに、残量が通知のしきい値を下回ったことをすでに知らせたか
      alerted: Record<string, boolean>
      // 残量パネル（スマホなど、入力欄の上の帯を描けない画面向け）が画面に出ているか
      paneOpen: boolean
    }
  }
}
