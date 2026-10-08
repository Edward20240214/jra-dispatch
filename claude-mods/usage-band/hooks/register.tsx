import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { UsageWindow } from '../types'

const windows = atom({ plugin: 'usage-band', key: 'windows' } as const, null)
const alerted = atom({ plugin: 'usage-band', key: 'alerted' } as const, {})
const paneOpen = atom({ plugin: 'usage-band', key: 'paneOpen' } as const, false)

// 入力欄の上の帯を描けない画面（スマホの Claude アプリ）では、残量をこのパネルに出す
const PANE = 'usage-band'

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

// リセット時刻を日本時間に直す。days は今日から何日後か
const jstOf = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)

  if (Number.isNaN(at)) {
    return undefined
  }

  const local = new Date(at + JST_OFFSET_MS)
  const today = new Date(now + JST_OFFSET_MS)

  return {
    month: local.getUTCMonth() + 1,
    date: local.getUTCDate(),
    hours: local.getUTCHours(),
    minutes: local.getUTCMinutes(),
    days:
      (Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
      DAY_MS,
  }
}

// 表示用の回復時刻（「1:20」「明日1:20」「10/14 21:00」）
const formatReset = (resetsAt: string | undefined, now: number) => {
  const t = jstOf(resetsAt, now)

  if (t === undefined) {
    return undefined
  }

  const time = `${t.hours}:${String(t.minutes).padStart(2, '0')}`

  return t.days === 0 ? time : t.days === 1 ? `明日${time}` : `${t.month}/${t.date} ${time}`
}

// 読み上げ用の回復時刻（「1時20分」「明日の1時20分」「10月14日の21時」）
const spokenResetOf = (resetsAt: string | undefined, now: number) => {
  const t = jstOf(resetsAt, now)

  if (t === undefined) {
    return undefined
  }

  const time = t.minutes === 0 ? `${t.hours}時` : `${t.hours}時${t.minutes}分`

  return t.days === 0 ? time : t.days === 1 ? `明日の${time}` : `${t.month}月${t.date}日の${time}`
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

// 帯か残量パネルのどちらかに出ていれば、ステータス行と回答の下の行は要らない
const isShown = async ($: EngineInterface) => (await drawsBand($)) || (await read($, paneOpen))

const pinStatus = async ($: EngineInterface, list: readonly UsageWindow[]) =>
  $.ui.status((await isShown($)) ? undefined : lineOf(list, await $.clock.now(), ' ｜ '))

const openPane = async ($: EngineInterface) => {
  const opened = await $.ui.open({ id: PANE, title: '残量', rows: 3 })

  await update($, paneOpen, () => opened.isPlaced)
  await pinStatus($, (await read($, windows)) ?? [])

  return opened.isPlaced
}

// PowerShell のスクリプトは、引用符や改行の扱いを気にせずに済むよう -EncodedCommand（UTF-16LE の base64）で渡す
const encodePowerShell = (script: string) => {
  let bytes = ''

  for (let i = 0; i < script.length; i += 1) {
    const code = script.charCodeAt(i)
    bytes += String.fromCharCode(code & 0xff, code >> 8)
  }

  return btoa(bytes)
}

// PowerShell の終了コードと標準出力。Windows 以外、または起動できなかったときは undefined。
// PowerShell 本体のフォルダ（C:\WINDOWS\System32\WindowsPowerShell\v1.0）で Claude Code を起動していると、
// 名前だけの powershell はそのフォルダから見つかり、安全のため実行を止められる。
// そのため絶対パスで呼び、作業フォルダも TEMP に移す
const runPowerShell = async ($: EngineInterface, script: string, env?: Record<string, string>) => {
  const systemRoot = await $.env.get('SystemRoot')

  if (systemRoot === undefined) {
    return undefined
  }

  const temp = await $.env.get('TEMP')

  return $.process
    .run(
      [
        `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShell(script),
      ],
      { cwd: temp ?? systemRoot, timeoutMs: 90_000, ...(env === undefined ? {} : { env }) },
    )
    .then(r => ({ exitCode: r.exitCode, stdout: r.stdout }))
    .catch(() => undefined)
}

const powershell = async ($: EngineInterface, script: string, env?: Record<string, string>) =>
  (await runPowerShell($, script, env))?.exitCode

const SPOKE_VOICEVOX = 10
const SPOKE_WINDOWS = 11

// VOICEVOX が起動していればその声で、なければ Windows に入っている日本語の声で読み上げる。
// 日本語の名前と文言は環境変数で渡し、VOICEVOX の応答はファイルのまま受け渡して文字化けを避ける。
// 終わり方: 10 = VOICEVOX、11 = Windows の声、2 = どちらも使えない
const WINDOWS_VOICE = `
$ErrorActionPreference = 'Stop'
$text = $env:USAGE_BAND_SPEECH
try {
  $base = 'http://127.0.0.1:50021'
  $speakersFile = Join-Path $env:TEMP 'usage-band-speakers.json'
  $queryFile = Join-Path $env:TEMP 'usage-band-query.json'
  $wavFile = Join-Path $env:TEMP 'usage-band.wav'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/speakers" -OutFile $speakersFile -TimeoutSec 3
  $speakers = Get-Content -Raw -Encoding UTF8 $speakersFile | ConvertFrom-Json
  $speaker = $speakers | Where-Object { $_.name -eq $env:USAGE_BAND_VOICE } | Select-Object -First 1
  if (-not $speaker) { $speaker = $speakers[0] }
  $id = $speaker.styles[0].id
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri ("$base/audio_query?speaker=$id&text=" + [uri]::EscapeDataString($text)) -OutFile $queryFile -TimeoutSec 30
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/synthesis?speaker=$id" -ContentType 'application/json' -InFile $queryFile -OutFile $wavFile -TimeoutSec 60
  (New-Object System.Media.SoundPlayer $wavFile).PlaySync()
  exit ${SPOKE_VOICEVOX}
} catch {}
try {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1
  if (-not $v) { exit 2 }
  $s.SelectVoice($v.VoiceInfo.Name)
  $s.Speak($text)
  exit ${SPOKE_WINDOWS}
} catch { exit 2 }
`

const WINDOWS_BEEP = `
[System.Media.SystemSounds]::Exclamation.Play()
Start-Sleep -Milliseconds 1500
`

type Via = 'voicevox' | 'speech' | 'beep' | 'none'

// VOICEVOX → Windows の日本語の声 → Claude Code の読み上げ（macOS など） → Windows の警告音の順に試す。
// どの方法で鳴らしたか（鳴らせなかったか）を返す
const sound = async ($: EngineInterface, text: string, voice: string): Promise<Via> => {
  const spoke = await powershell($, WINDOWS_VOICE, { USAGE_BAND_SPEECH: text, USAGE_BAND_VOICE: voice })

  if (spoke === SPOKE_VOICEVOX) {
    return 'voicevox'
  }

  if (spoke === SPOKE_WINDOWS) {
    return 'speech'
  }

  try {
    await $.audio.speak(text)

    return 'speech'
  } catch {
    return (await powershell($, WINDOWS_BEEP)) === 0 ? 'beep' : 'none'
  }
}

const DEFAULT_VOICE = '冥鳴ひまり'

// 読み上げの声（VOICEVOX）と、呼びかける名前（空なら呼びかけない）
type Speech = { voice: string; name: string }

const callOf = (name: string) => (name === '' ? '' : `${name}さん、`)

// 「けんいちさん、5時間枠の残りが、20パーセントを切りましたよ。1時20分に回復します。」
const alertSpeechOf = (low: readonly UsageWindow[], now: number, name: string) => {
  const frames = low.map(w => `${LABELS[w.kind] ?? w.kind}枠`)
  const times = low.map(w => spokenResetOf(w.resetsAt, now))
  const recovery = times.some(t => t === undefined)
    ? ''
    : low.length === 1
      ? `${times[0]}に回復します。`
      : `${frames.map((f, i) => `${f}は${times[i]}`).join('、')}に回復します。`

  return `${callOf(name)}${frames.join('と')}の残りが、${ALERT_BELOW}パーセントを切りましたよ。${recovery}`
}

const reportOf = (via: Via, voice: string) =>
  ({
    voicevox: `トーストと VOICEVOX（${voice}）の声で知らせました。`,
    speech: 'トーストと標準の声で知らせました（VOICEVOX を起動しておくと、より自然な声になります）。',
    beep: 'トーストと Windows の警告音で知らせました（日本語の読み上げが使えないため）。',
    none: 'トーストは出しましたが、音は鳴らせませんでした。',
  })[via]

// しきい値を下回った枠を一度だけ知らせる。リセットで回復したら、次に下回ったときにまた知らせる
const alertLow = async ($: EngineInterface, list: readonly UsageWindow[], speech: Speech) => {
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
  void sound($, alertSpeechOf(fresh, now, speech.name), speech.voice)
}

// 残量の記録: 残量が変わるたびに1行、ホームフォルダの .claude/usage-band/usage-log-YYYY-MM.csv に足していく。
// 列名と値は ASCII だけにして、Excel でも R や pandas でもそのまま開けるようにする
const LOG_HEADER =
  'timestamp_jst,weekday,hour,five_hour_used_pct,five_hour_resets_jst,seven_day_used_pct,seven_day_resets_jst\n'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')

// 2026-10-07T21:05:09+09:00
const jstIsoOf = (ms: number) => {
  const d = new Date(ms + JST_OFFSET_MS)

  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`
}

const logPathOf = async ($: EngineInterface, now: number) => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  if (home === undefined) {
    return undefined
  }

  const d = new Date(now + JST_OFFSET_MS)
  // Windows のホーム（C:\Users\...）なら \ で、それ以外は / でつなぐ
  const sep = home.includes('\\') ? '\\' : '/'

  return [home, '.claude', 'usage-band', `usage-log-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}.csv`].join(sep)
}

const logRowOf = (list: readonly UsageWindow[], now: number) => {
  const local = new Date(now + JST_OFFSET_MS)
  const cells = (kind: string) => {
    const w = list.find(one => one.kind === kind)
    const at = w?.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)

    return [w === undefined ? '' : String(w.percentUsed), Number.isNaN(at) ? '' : jstIsoOf(at)]
  }

  return `${[jstIsoOf(now), WEEKDAYS[local.getUTCDay()], local.getUTCHours(), ...cells('five_hour'), ...cells('seven_day')].join(',')}\n`
}

// 書き込めなかった記録の取り置き（ファイルごとの、まだ書いていない行）。$.store は次の起動まで残る
const PENDING_KEY = 'pendingLog'

type Pending = Record<string, string>

const pendingOf = async ($: EngineInterface): Promise<Pending> => {
  const stored = await $.store.get(PENDING_KEY)

  return typeof stored === 'object' && stored !== null
    ? Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
}

const rowCountOf = (rows: string) => rows.split('\n').filter(line => line !== '').length

const LOCKED_WARNING =
  '⚠ 残量の記録ファイルが Excel などで開かれているため、書き込めませんでした。閉じると、たまった分もまとめて書き込みます。中身を見るときは /usage-band-open を使ってください'

// 取り置きの行を書き込む。書けなかったファイルの分は、取り置きのまま返す。
// 読めないファイルを「まだない」とみなして上書きしないよう、あるかどうかを先に確かめる
const flushPending = async ($: EngineInterface, pending: Pending) => {
  const left: Pending = {}

  for (const [path, rows] of Object.entries(pending)) {
    try {
      const before = (await $.fs.exists(path)) ? await $.fs.read(path) : LOG_HEADER

      await $.fs.write(path, before + rows)
    } catch {
      left[path] = rows
    }
  }

  return left
}

// 記録に失敗しても、表示と通知は止めない
const appendLog = async ($: EngineInterface, list: readonly UsageWindow[]) => {
  try {
    const now = await $.clock.now()
    const path = await logPathOf($, now)

    if (path === undefined || list.length === 0) {
      return
    }

    const pending = await pendingOf($)
    const left = await flushPending($, { ...pending, [path]: (pending[path] ?? '') + logRowOf(list, now) })

    if (Object.keys(left).length === 0) {
      if (Object.keys(pending).length > 0) {
        await $.store.delete(PENDING_KEY)
      }

      return
    }

    await $.store.set(PENDING_KEY, left)
    $.ui.toast(LOCKED_WARNING, { timeoutMs: 15_000 })
  } catch {
    // 記録できなかった分は諦める
  }
}

// 記録のコピーを TEMP\usage-band に作って Excel で開く。元のファイルは開かないので、記録は止まらない。
// 前に開いたコピーを Excel で開いたままでもぶつからないよう、コピーには毎回、開いた日時を付けた名前を付ける。
// 閉じてある古いコピーは片づける（開いているものは消せないので、そのまま残る）。
// 失敗したら理由を UTF-8 のバイト列のまま書き出す（画面の文字コードに左右されないように）。終わり方: 0 = Excel で開いた、4 = 既定のアプリで開いた、3 = 記録ファイルがない、1 = 失敗
const OPEN_COPY = `
$ErrorActionPreference = 'Stop'
try {
  $src = $env:USAGE_BAND_LOG
  if (-not (Test-Path $src)) { exit 3 }
  $dir = Join-Path $env:TEMP 'usage-band'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Get-ChildItem -Path $dir -Filter '*.csv' | Remove-Item -ErrorAction SilentlyContinue
  $name = [IO.Path]::GetFileNameWithoutExtension($src) + '_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.csv'
  $dst = Join-Path $dir $name
  Copy-Item -Path $src -Destination $dst
  try {
    Start-Process excel -ArgumentList ('"' + $dst + '"')
    exit 0
  } catch {
    Invoke-Item $dst
    exit 4
  }
} catch {
  $bytes = [Text.Encoding]::UTF8.GetBytes($_.Exception.Message)
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
  exit 1
}
`

const OPEN_REPORTS: Record<number, string> = {
  0: '記録のコピーを Excel で開きました。元のファイルは開いていないので、見ているあいだも記録は止まりません。',
  4: 'Excel が見つからなかったため、記録のコピーをいつものアプリで開きました。元のファイルは開いていないので、記録は止まりません。',
  3: 'まだ今月の記録ファイルがありません。残量が変わると記録が始まります。',
}

const save = async ($: EngineInterface, rateLimits: readonly SessionRateLimit[], speech: Speech) => {
  const list = (await update($, windows, () => rateLimits.map(w => ({ ...w })))) ?? []

  await pinStatus($, list)
  await alertLow($, list, speech)
}

export const register: Register = (on, options) => {
  const voice = typeof options.voice === 'string' && options.voice !== '' ? options.voice : DEFAULT_VOICE
  // 「けんいちさん」と書かれていても「さん」が重ならないようにする
  const name = typeof options.name === 'string' ? options.name.trim().replace(/さん$/, '') : ''
  const speech: Speech = { voice, name }
  const shouldLog = options.log !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-band-test',
      description: '残量の通知（トーストと音）をその場で試す',
    })
    await $.command.register({
      name: 'usage-band-log',
      description: '残量の記録ファイルの場所と、今月の件数を表示する',
    })
    await $.command.register({
      name: 'usage-band-open',
      description: '残量の記録のコピーを Excel で開く（記録を止めずに見られる）',
    })
    await $.command.register({
      name: 'usage-band-pane',
      description: '残量パネルを開く（スマホなど、入力欄の上に残量が出ない画面向け）',
    })

    const result = await next(e)
    const { rateLimits } = await $.session.usage()

    // 再読み込み時に、前回の値を空の読み取りで消さない
    if (rateLimits.length > 0) {
      await save($, rateLimits, speech)
    } else {
      await pinStatus($, (await read($, windows)) ?? [])
    }

    return result
  })

  // しきい値を変えずに、本番と同じトーストと音をその場で出して確かめる
  on('command.run', { command: 'usage-band-test' }, async $ => {
    const list = (await read($, windows)) ?? []
    const current = list.map(w => `${LABELS[w.kind] ?? w.kind} ${Math.round(remainingOf(w))}%`).join(' ｜ ')

    $.ui.toast(
      `【テスト】残量が${ALERT_BELOW}%を切ると、このように知らせます${current === '' ? '' : `（今の残量：${current}）`}`,
      { timeoutMs: 10_000 },
    )

    // 今の残量があれば、最初の枠が下回ったときの本番の言い回しで読み上げる
    const first = list[0]
    const text =
      first === undefined
        ? `テストです。${callOf(name)}残量が${ALERT_BELOW}パーセントを切ると、このようにお知らせします。`
        : `テストです。${alertSpeechOf([first], await $.clock.now(), name)}`
    const via = await sound($, text, voice)

    return { text: `テスト通知：${reportOf(via, voice)}` }
  })

  on('command.run', { command: 'usage-band-log' }, async $ => {
    const path = await logPathOf($, await $.clock.now())

    if (path === undefined) {
      return { text: '記録ファイルの置き場所（ホームフォルダ）が分かりませんでした。' }
    }

    const rows = await $.fs
      .read(path)
      .then(text => rowCountOf(text) - 1)
      .catch(() => 0)
    const held = Object.values(await pendingOf($)).reduce((sum, text) => sum + rowCountOf(text), 0)
    const lines = [
      `記録ファイル：${path}`,
      `今月の記録：${rows} 件${shouldLog ? '' : '（記録は止めてあります。設定 log を true にすると再開します）'}`,
      ...(held === 0 ? [] : [`書き込めずに取り置いている記録：${held} 件（記録ファイルを閉じると、次の記録のときにまとめて書き込みます）`]),
      '中身を見るときは /usage-band-open を使うと、記録を止めずに見られます。',
    ]

    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'usage-band-open' }, async $ => {
    const path = await logPathOf($, await $.clock.now())

    if (path === undefined) {
      return { text: '記録ファイルの置き場所（ホームフォルダ）が分かりませんでした。' }
    }

    // 取り置きがあれば、先に書き込んでからコピーする
    const pending = await pendingOf($)

    if (Object.keys(pending).length > 0) {
      const left = await flushPending($, pending)

      await (Object.keys(left).length === 0 ? $.store.delete(PENDING_KEY) : $.store.set(PENDING_KEY, left))
    }

    const opened = await runPowerShell($, OPEN_COPY, { USAGE_BAND_LOG: path })

    if (opened === undefined) {
      return { text: `この機能は Windows 用です。記録ファイル：${path}` }
    }

    const reason = opened.stdout.trim().slice(0, 300)

    return {
      text:
        OPEN_REPORTS[opened.exitCode] ??
        `記録のコピーを開けませんでした${reason === '' ? '' : `（理由：${reason}）`}。記録ファイル：${path}`,
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await save($, e.rateLimits, speech)

      if (shouldLog) {
        await appendLog($, e.rateLimits)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined || e.reason !== 'answer' || (await isShown($))) {
      return result
    }

    const list = await read($, windows)

    if (list === null || list.length === 0) {
      return result
    }

    return { ...result, text: lineOf(list, await $.clock.now(), '\n') }
  })

  // スマホがつながったら残量パネルを開き、スマホがすべて離れたら閉じる
  on('session.attach', { surface: 'mobile' }, async ($, e, next) => {
    const result = await next(e)

    await openPane($)

    return result
  })

  on('session.detach', { surface: 'mobile' }, async ($, e, next) => {
    const result = await next(e)

    if (!(await $.session.surfaces()).includes('mobile')) {
      await $.ui.close({ id: PANE })
    }

    return result
  })

  // 残量パネルが閉じたことを覚えておく。閉じること自体は決して止めない
  on('ui.close', async ($, e, next) => {
    const result = await next(e)

    if (e.id === PANE) {
      await update($, paneOpen, () => false)
      await pinStatus($, (await read($, windows)) ?? [])
    }

    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-band-pane' }, async $ => ({
    text: (await openPane($))
      ? '残量パネルを開きました。閉じるときは、パネルの閉じる印か Esc キーを使います。'
      : '残量パネルは開く準備ができていますが、この画面ではまだ表示されていません。',
  }))

  // 残量パネルの中身: 枠ごとに1行（スマホの細い画面でも収まるように）
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, windows)
    const { Box, Text } = $.ui.resolve(e)

    if (list === null || list.length === 0) {
      return <Text dimColor>残量: 取得待ち（返事が届くと表示されます）</Text>
    }

    const now = await $.clock.now()
    const cells = e.props.bodyColumns >= 34 ? 10 : 5

    return (
      <Box flexDirection="column">
        {list.map(w => {
          const remaining = remainingOf(w)
          const color = colorOf(remaining)

          return (
            <Text wrap="truncate-end">
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
      </Box>
    )
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
