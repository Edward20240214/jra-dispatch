import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { UsageWindow } from '../types'

const windows = atom({ plugin: 'usage-band', key: 'windows' } as const, null)
const alerted = atom({ plugin: 'usage-band', key: 'alerted' } as const, {})

const LABELS: Record<string, string> = {
  five_hour: '5時間',
  seven_day: '週間',
  spend_limit: '上限額',
}

// 日本時間 (UTC+9、夏時間なし) でリセット時刻を表示する
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// 帯の幅がこれより狭いときはバーを半分の長さにして、1行に収める
const WIDE_COLUMNS = 80

// 残量がこの値(%)を下回ったら、トーストと音で一度だけ知らせる
const ALERT_BELOW = 20

const remainingOf = (w: UsageWindow) =>
  Math.min(100, Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10))

const colorOf = (remaining: number) =>
  remaining >= 50 ? 'success' : remaining >= 20 ? 'warning' : 'error'

const barOf = (remaining: number, cells: number) => {
  const filled = Math.round((remaining / 100) * cells)

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

const formatReset = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)

  if (Number.isNaN(at)) {
    return undefined
  }

  const local = new Date(at + JST_OFFSET_MS)
  const today = new Date(now + JST_OFFSET_MS)
  const time = `${local.getUTCHours()}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  const days =
    (Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
    DAY_MS

  return days === 0 ? time : days === 1 ? `明日${time}` : `${local.getUTCMonth() + 1}/${local.getUTCDate()} ${time}`
}

const recoveryOf = (w: UsageWindow, now: number) => {
  const reset = formatReset(w.resetsAt, now)

  return reset === undefined ? '' : ` ${reset}回復`
}

// 色が付けられない文字だけの表示では、色の代わりに印を付ける
const MARKS = { success: '🟢', warning: '🟡', error: '🔴' } as const

// separator: ステータス行は1行に並べ、回答の下では枠ごとに改行する
const lineOf = (list: readonly UsageWindow[], now: number, separator: string) =>
  list.length === 0
    ? '残量: 取得待ち'
    : `残量${separator}${list
        .map(w => {
          const remaining = remainingOf(w)

          return `${MARKS[colorOf(remaining)]} ${LABELS[w.kind] ?? w.kind} ${barOf(remaining, 10)} ${Math.round(remaining)}%${recoveryOf(w, now)}`
        })
        .join(separator)}`

// 入力欄の上の帯を描けるのはターミナルとデスクトップの Code タブだけ。
// それ以外（クラウドセッションを Claude アプリで見ている場合など）は、ステータス行と回答の下の1行で代わりに出す
const drawsBand = async ($: EngineInterface) =>
  (await $.session.surfaces()).some(s => s === 'terminal' || s === 'desktop')

const pinStatus = async ($: EngineInterface, list: readonly UsageWindow[]) =>
  $.ui.status((await drawsBand($)) ? undefined : lineOf(list, await $.clock.now(), ' ｜ '))

const powershell = ($: EngineInterface, script: readonly string[], env?: Record<string, string>) =>
  $.process
    .run(['powershell', '-NoProfile', '-Command', script.join('; ')], env === undefined ? undefined : { env })
    .then(r => r.exitCode === 0)
    .catch(() => false)

// Windows に入っている日本語の声で読み上げる。日本語の声がなければ 2 で終わる。
// 文言は引用符の扱いを気にせずに済むよう、環境変数で渡す
const WINDOWS_SPEECH = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1",
  'if (-not $v) { exit 2 }',
  '$s.SelectVoice($v.VoiceInfo.Name)',
  '$s.Speak($env:USAGE_BAND_SPEECH)',
]

const WINDOWS_BEEP = ['[System.Media.SystemSounds]::Exclamation.Play()', 'Start-Sleep -Milliseconds 1500']

// Claude Code の読み上げ → Windows の日本語音声 → Windows の警告音の順に試す。
// どの方法で鳴らしたか（鳴らせなかったか）を返す
const sound = async ($: EngineInterface, text: string): Promise<'speech' | 'beep' | 'none'> => {
  try {
    await $.audio.speak(text)

    return 'speech'
  } catch {
    if (await powershell($, WINDOWS_SPEECH, { USAGE_BAND_SPEECH: text })) {
      return 'speech'
    }

    return (await powershell($, WINDOWS_BEEP)) ? 'beep' : 'none'
  }
}

const TEST_COMMAND = 'usage-band-test'

const SOUND_REPORTS = {
  speech: 'トーストと読み上げで知らせました。',
  beep: 'トーストと Windows の警告音で知らせました（日本語の読み上げが使えないため）。',
  none: 'トーストは出しましたが、音は鳴らせませんでした。',
} as const

// しきい値を下回った枠を一度だけ知らせる。リセットで回復したら、次に下回ったときにまた知らせる
const alertLow = async ($: EngineInterface, list: readonly UsageWindow[]) => {
  const before = await read($, alerted)
  const fresh = list.filter(w => remainingOf(w) < ALERT_BELOW && !before[w.kind])

  await update($, alerted, () => Object.fromEntries(list.map(w => [w.kind, remainingOf(w) < ALERT_BELOW])))

  if (fresh.length === 0) {
    return
  }

  const now = await $.clock.now()
  const labels = fresh.map(w => LABELS[w.kind] ?? w.kind)

  // トーストは同じプラグインの前のものと入れ替わるので、下回った枠を1つにまとめる
  $.ui.toast(
    `⚠ 残量が${ALERT_BELOW}%を切りました：${fresh
      .map((w, i) => `${labels[i]} 残り${Math.round(remainingOf(w))}%${recoveryOf(w, now)}`)
      .join(' ｜ ')}`,
    { timeoutMs: 10_000 },
  )
  // 読み上げを待つと残量の更新が止まるので、待たずに鳴らす
  void sound($, `${labels.map(l => `${l}枠`).join('と')}の残りが${ALERT_BELOW}パーセントを切りました`)
}

const save = async ($: EngineInterface, rateLimits: readonly SessionRateLimit[]) => {
  const list = (await update($, windows, () => rateLimits.map(w => ({ ...w })))) ?? []

  await pinStatus($, list)
  await alertLow($, list)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: TEST_COMMAND,
      description: '残量の通知（トーストと音）をその場で試す',
    })

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

  // しきい値を変えずに、本番と同じトーストと音をその場で出して確かめる
  on('command.run', { command: TEST_COMMAND }, async $ => {
    const list = (await read($, windows)) ?? []
    const current = list.map(w => `${LABELS[w.kind] ?? w.kind} ${Math.round(remainingOf(w))}%`).join(' ｜ ')

    $.ui.toast(
      `【テスト】残量が${ALERT_BELOW}%を切ると、このように知らせます${current === '' ? '' : `（今の残量：${current}）`}`,
      { timeoutMs: 10_000 },
    )

    const via = await sound($, `通知のテストです。残量が${ALERT_BELOW}パーセントを切ると、このようにお知らせします`)

    return { text: `テスト通知：${SOUND_REPORTS[via]}` }
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
          <Text dimColor wrap="truncate-end">
            残量: 取得待ち（返事が届くと表示されます）
          </Text>
        </Box>
      )
    }

    const now = await $.clock.now()
    const cells = e.props.bodyColumns >= WIDE_COLUMNS ? 10 : 5

    // 1つの Text にまとめ、幅が足りなくても折り返さずに末尾を切る
    return (
      <Box>
        <Text wrap="truncate-end">
          <Text dimColor>残量 </Text>
          {list.map((w, i) => {
            const remaining = remainingOf(w)
            const color = colorOf(remaining)

            return (
              <Text>
                {i === 0 ? null : <Text dimColor> ｜ </Text>}
                <Text dimColor>{LABELS[w.kind] ?? w.kind} </Text>
                <Text color={color}>{barOf(remaining, cells)}</Text>
                <Text bold color={color}>
                  {' '}
                  {Math.round(remaining)}%
                </Text>
                <Text dimColor>{recoveryOf(w, now)}</Text>
              </Text>
            )
          })}
        </Text>
      </Box>
    )
  })
}
