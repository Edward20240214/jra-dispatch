import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { UsageWindow } from '../types'

const windows = atom({ plugin: 'usage-band', key: 'windows' } as const, null)

const LABELS: Record<string, string> = {
  five_hour: '5時間枠',
  seven_day: '週間枠',
  spend_limit: '利用上限額',
}

// 日本時間 (UTC+9、夏時間なし) でリセット時刻を表示する
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

const BAR_CELLS = 10

const remainingOf = (w: UsageWindow) =>
  Math.min(100, Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10))

const colorOf = (remaining: number) =>
  remaining >= 50 ? 'success' : remaining >= 20 ? 'warning' : 'error'

const barOf = (remaining: number) => {
  const filled = Math.round((remaining / 100) * BAR_CELLS)

  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

const formatReset = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)

  if (Number.isNaN(at)) {
    return undefined
  }

  const local = new Date(at + JST_OFFSET_MS)
  const today = new Date(now + JST_OFFSET_MS)
  const time = `${local.getUTCHours()}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  const isToday =
    local.getUTCFullYear() === today.getUTCFullYear() &&
    local.getUTCMonth() === today.getUTCMonth() &&
    local.getUTCDate() === today.getUTCDate()

  return isToday ? time : `${local.getUTCMonth() + 1}/${local.getUTCDate()} ${time}`
}

// 色が付けられない文字だけの表示では、色の代わりに印を付ける
const MARKS = { success: '🟢', warning: '🟡', error: '🔴' } as const

// separator: ステータス行は1行に並べ、回答の下では枠ごとに改行する
const lineOf = (list: readonly UsageWindow[], now: number, separator: string) =>
  list.length === 0
    ? '残り使用量: 取得待ち'
    : `残り使用量${separator}${list
        .map(w => {
          const remaining = remainingOf(w)
          const reset = formatReset(w.resetsAt, now)

          return `${MARKS[colorOf(remaining)]} ${LABELS[w.kind] ?? w.kind} ${barOf(remaining)} 残り${remaining}%${reset === undefined ? '' : `（${reset}リセット）`}`
        })
        .join(separator)}`

// 入力欄の上の帯を描けるのはターミナルとデスクトップの Code タブだけ。
// それ以外（クラウドセッションを Claude アプリで見ている場合など）は、ステータス行と回答の下の1行で代わりに出す
const drawsBand = async ($: EngineInterface) =>
  (await $.session.surfaces()).some(s => s === 'terminal' || s === 'desktop')

const pinStatus = async ($: EngineInterface, list: readonly UsageWindow[]) =>
  $.ui.status((await drawsBand($)) ? undefined : lineOf(list, await $.clock.now(), ' ｜ '))

const save = async ($: EngineInterface, rateLimits: readonly SessionRateLimit[]) => {
  const list = await update($, windows, () => rateLimits.map(w => ({ ...w })))

  await pinStatus($, list ?? [])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { rateLimits } = await $.session.usage()

    // 再読み込み時に、前回の値を空の読み取りで消さない
    if (rateLimits.length > 0) {
      await save($, rateLimits)
    } else {
      await pinStatus($, (await read($, windows)) ?? [])
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await save($, e.rateLimits)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined || e.reason !== 'answer' || (await drawsBand($))) {
      return result
    }

    const list = await read($, windows)

    if (list === null || list.length === 0) {
      return result
    }

    return { ...result, text: lineOf(list, await $.clock.now(), '\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, windows)
    const { Box, Text } = $.ui.resolve(e)

    if (list === null || list.length === 0) {
      return (
        <Box>
          <Text dimColor>残り使用量: 取得待ち（応答が届くと表示されます）</Text>
        </Box>
      )
    }

    const now = await $.clock.now()

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
        <Text dimColor>残り使用量</Text>
        {list.map(w => {
          const remaining = remainingOf(w)
          const color = colorOf(remaining)
          const reset = formatReset(w.resetsAt, now)

          return (
            <Box key={w.kind}>
              <Text>
                <Text dimColor>{LABELS[w.kind] ?? w.kind} </Text>
                <Text color={color}>{barOf(remaining)}</Text>
                <Text> 残り</Text>
                <Text bold color={color}>
                  {remaining}%
                </Text>
                {reset === undefined ? null : <Text dimColor>（{reset}リセット）</Text>}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
