import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const STATUS = '残量 ｜ 🟡 5時間 █░░░░ 28% 14:30回復 ｜ 🟢 週間 ███░░ 55% 10/10 9:00回復'

const BENEATH = ['残量', '🟡 5時間 █░░░░ 28% 14:30回復', '🟢 週間 ███░░ 55% 10/10 9:00回復'].join('\n')

const props = (bodyColumns = 100, hasSurvey = false) => ({
  hasSurvey,
  isWorking: false,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
})

// The machine the session runs on, as far as sound goes:
// mac: Claude Code's own speech works and there is no PowerShell;
// windows-*: no speech of Claude Code's own, and PowerShell finds VOICEVOX running,
// only the Windows Japanese voice, or no Japanese voice at all
type Host = 'mac' | 'windows-voicevox' | 'windows-voice' | 'windows-silent'

const VOICE_EXIT = { 'windows-voicevox': 10, 'windows-voice': 11, 'windows-silent': 2 } as const

const WINDOWS_ENV: Record<string, string> = {
  SystemRoot: 'C:\\WINDOWS',
  TEMP: 'C:\\Users\\kenichi\\AppData\\Local\\Temp',
  USERPROFILE: 'C:\\Users\\kenichi',
}

const LOG_PATH = 'C:\\Users\\kenichi\\.claude\\usage-band\\usage-log-2026-10.csv'

// The test host is not Windows, so the engine reads a C:\ path as relative to the session's folder:
// find the log by the end of its path
const logOf = (files: Map<string, string>) => [...files.entries()].find(([path]) => path.endsWith(LOG_PATH))
const LOG_HEADER =
  'timestamp_jst,weekday,hour,five_hour_used_pct,five_hour_resets_jst,seven_day_used_pct,seven_day_resets_jst'

// 2026-10-07 12:00 JST; what the engine answers beneath the plugin
const setup = (
  on: On,
  surfaces: readonly RenderSurface[] = ['terminal'],
  host: Host = 'mac',
  stored: Readonly<Record<string, unknown>> = {},
) => {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const spoken: string[] = []
  const voiceScripts: { text?: string; voice?: string }[] = []
  const beeps: (readonly string[])[] = []
  const launches: { executable?: string; cwd?: string }[] = []
  // the files the plugin reads and writes, in memory; a locked one is open in Excel
  const files = new Map<string, string>()
  const locked = new Set<string>()
  const opens: (string | undefined)[] = []
  // set a message to make the copy fail, as PowerShell reports it
  const openFailure: { message?: string } = {}
  // the clients drawing the session: a test pushes 'mobile' as a phone joins
  const roster: RenderSurface[] = [...surfaces]
  const panesOpened: string[] = []
  const panesClosed: string[] = []

  const clock = mock.clock(on, { now: Date.parse('2026-10-07T03:00:00Z') })
  mock.store(on, stored)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.surfaces', () => ({ value: [...roster] }))
  // what the session already holds, as $.session.usage() answers it: a test fills it to stand for a reload
  const held: { rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] } = { rateLimits: [] }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: held.rateLimits } }))
  on('ui.open', ($, e) => {
    panesOpened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panesClosed.push(e.id)

    return { value: undefined }
  })
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.detach', ($, e) => ({ clientId: e.clientId }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('audio.speak', ($, e) => {
    if (host !== 'mac') {
      return { deny: 'no synthesizer' }
    }

    spoken.push(e.text)

    return { value: { via: 'system' as const } }
  })
  on('process.run', ($, e) => {
    if (host === 'mac') {
      return { deny: 'powershell: command not found' }
    }

    launches.push({ executable: e.argv[0], cwd: e.init?.cwd })

    const env = e.init?.env
    const log = env?.USAGE_BAND_LOG

    // opening a copy of the log: like Test-Path, a missing file ends with 3
    if (log !== undefined) {
      opens.push(log)

      const exitCode =
        openFailure.message !== undefined ? 1 : [...files.keys()].some(path => path.endsWith(log)) ? 0 : 3

      return {
        value: { exitCode, stdout: openFailure.message ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    }

    // the voice script carries its text in the environment; the warning sound carries none
    const isVoice = env?.USAGE_BAND_SPEECH !== undefined

    if (isVoice) {
      voiceScripts.push({ text: env?.USAGE_BAND_SPEECH, voice: env?.USAGE_BAND_VOICE })
    } else {
      beeps.push(e.argv)
    }

    const exitCode = isVoice ? VOICE_EXIT[host] : 0

    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', ($, e) => ({ value: host === 'mac' ? undefined : WINDOWS_ENV[e.name] }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: 'ENOENT: no such file' } : { value: text }
  })
  on('fs.write', ($, e) => {
    if (locked.has(e.path)) {
      return { deny: 'EBUSY: resource busy or locked' }
    }

    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return {
    clock,
    statuses,
    toasts,
    spoken,
    voiceScripts,
    beeps,
    launches,
    files,
    locked,
    opens,
    openFailure,
    roster,
    panesOpened,
    panesClosed,
    held,
  }
}

// 5時間枠は 2026-10-07 14:30 JST、週間枠は 2026-10-10 09:00 JST にリセット
const measure = ($: Engine, percentUsed: number, fiveHourResetsAt = '2026-10-07T05:30:00Z', weeklyUsed = 45) =>
  $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed, resetsAt: fiveHourResetsAt },
      { kind: 'seven_day', percentUsed: weeklyUsed, resetsAt: '2026-10-10T00:00:00Z' },
    ],
    changed: ['rateLimits'],
  })

// the person typing /usage-band-test at the prompt
const runTestCommand = ($: Engine) =>
  $.command.run({
    command: 'usage-band-test',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

const completeTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

const mountBand = ($: Engine, surface: (typeof SURFACES)[number], bodyColumns?: number, hasSurvey?: boolean) =>
  $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: props(bodyColumns, hasSurvey) })

test('shows a waiting hint before the first reading', async ($, on) => {
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)

    expect(await band.find({ text: /取得待ち/ })).toBeDefined()
    await band.unmount()
  }
})

test('draws both windows on one line with bars, percent and recovery time in JST', async ($, on) => {
  setup(on)
  await measure($, 72.5)

  for (const surface of SURFACES) {
    const band = await mountBand($, surface)

    expect(
      await band.find({ text: /^残量 5時間 ███░░░░░░░ 28% 14:30回復 ｜ 週間 ██████░░░░ 55% 10\/10 9:00回復$/ }),
    ).toBeDefined()
    await band.unmount()
  }
})

test('halves the bars where the band is narrow', async ($, on) => {
  setup(on)
  await measure($, 72.5)

  const band = await mountBand($, 'desktop', 60)

  expect(await band.find({ text: /^残量 5時間 █░░░░ 28% 14:30回復 ｜ 週間 ███░░ 55% 10\/10 9:00回復$/ })).toBeDefined()
  await band.unmount()
})

test('says 明日 for a reset tomorrow', async ($, on) => {
  setup(on)
  // 2026-10-08 01:20 JST
  await measure($, 6, '2026-10-07T16:20:00Z')

  const band = await mountBand($, 'terminal')

  expect(await band.find({ text: /5時間 █████████░ 94% 明日1:20回復/ })).toBeDefined()
  await band.unmount()
})

test('redraws when a later measurement moves the window', async ($, on) => {
  setup(on)
  await measure($, 10)

  const band = await mountBand($, 'terminal')

  expect(await band.find({ text: /5時間 \S+ 90%/ })).toBeDefined()

  await measure($, 85)

  expect(await band.find({ text: /5時間 \S+ 15%/ })).toBeDefined()
  expect(await band.find({ text: /5時間 \S+ 90%/ })).toBeUndefined()
  await band.unmount()
})

test('yields the band to a survey', async ($, on) => {
  setup(on)
  // the engine's survey, drawn beneath the plugin
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>survey</Text>
  })
  await measure($, 10)

  const band = await mountBand($, 'terminal', 100, true)

  expect(await band.find({ text: /survey/ })).toBeDefined()
  expect(await band.find({ text: /残量/ })).toBeUndefined()
  await band.unmount()
})

test('without a surface that draws the band, pins the figures on the status line', async ($, on) => {
  const { statuses } = setup(on, [])

  await measure($, 72.5)

  expect(statuses.at(-1)).toBe(STATUS)
})

test('without a surface that draws the band, adds the figures beneath each answer', async ($, on) => {
  setup(on, [])
  await measure($, 72.5)

  expect((await completeTurn($)).text).toBe(BENEATH)
})

test('on the terminal, leaves the status line and the answer alone', async ($, on) => {
  const { statuses } = setup(on, ['terminal'])

  await measure($, 72.5)

  expect(statuses.at(-1)).toBeUndefined()
  expect((await completeTurn($)).text).toBe('done')
})

const ALERT = '5時間枠の残りが、20パーセントを切りましたよ。14時30分に回復します。'
// 残量をまだ取得していないときのテストの読み上げ
const TEST_SPEECH = 'テストです。残量が20パーセントを切ると、このようにお知らせします。'

test('alerts once, with a toast and speech, when a window drops below 20%', async ($, on) => {
  const { clock, toasts, spoken } = setup(on)

  await measure($, 70)
  expect(toasts).toHaveLength(0)

  await measure($, 85)
  // 音は残量の更新を止めないよう待たずに鳴らすので、鳴り終わるまで進める
  await clock.settle()
  expect(toasts).toEqual(['⚠ 残量が20%を切りました：5時間 残り15% 14:30回復'])
  expect(spoken).toEqual([ALERT])

  await measure($, 90)
  await clock.settle()
  expect(toasts).toHaveLength(1)
  expect(spoken).toHaveLength(1)
})

test('alerts again after the window resets and drops below 20% once more', async ($, on) => {
  const { toasts } = setup(on)

  await measure($, 85)
  await measure($, 10)
  await measure($, 85)

  expect(toasts).toHaveLength(2)
})

test('on Windows, speaks the alert through PowerShell with the default VOICEVOX voice', async ($, on) => {
  const { clock, voiceScripts, spoken, beeps } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 85)
  await clock.settle()

  expect(voiceScripts).toEqual([{ text: ALERT, voice: '冥鳴ひまり' }])
  expect(spoken).toHaveLength(0)
  expect(beeps).toHaveLength(0)
})

test('plays the Windows warning sound where no Japanese voice is installed', async ($, on) => {
  const { clock, toasts, beeps } = setup(on, ['terminal'], 'windows-silent')

  await measure($, 85)
  await clock.settle()

  expect(toasts).toHaveLength(1)
  expect(beeps).toHaveLength(1)
  expect(beeps[0]).toContain('-EncodedCommand')
})

test('the test command shows the toast and reports VOICEVOX', async ($, on) => {
  const { toasts, voiceScripts } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 6)

  const { text } = await runTestCommand($)

  expect(toasts).toEqual(['【テスト】残量が20%を切ると、このように知らせます（今の残量：5時間 94% ｜ 週間 55%）'])
  expect(voiceScripts).toEqual([{ text: `テストです。${ALERT}`, voice: '冥鳴ひまり' }])
  expect(text).toBe('テスト通知：トーストと VOICEVOX（冥鳴ひまり）の声で知らせました。')
})

test('the test command uses the voice chosen in the settings', { options: { voice: 'ずんだもん' } }, async ($, on) => {
  const { voiceScripts } = setup(on, ['terminal'], 'windows-voicevox')

  const { text } = await runTestCommand($)

  expect(voiceScripts[0]?.voice).toBe('ずんだもん')
  expect(text).toBe('テスト通知：トーストと VOICEVOX（ずんだもん）の声で知らせました。')
})

test('the test command reports the standard voice when VOICEVOX is not running', async ($, on) => {
  const { voiceScripts } = setup(on, ['terminal'], 'windows-voice')

  const { text } = await runTestCommand($)

  expect(voiceScripts).toHaveLength(1)
  expect(text).toBe('テスト通知：トーストと標準の声で知らせました（VOICEVOX を起動しておくと、より自然な声になります）。')
})

test('the test command uses Claude Code\'s own speech where there is no PowerShell', async ($, on) => {
  const { spoken } = setup(on, ['terminal'], 'mac')

  const { text } = await runTestCommand($)

  expect(spoken).toEqual([TEST_SPEECH])
  expect(text).toBe('テスト通知：トーストと標準の声で知らせました（VOICEVOX を起動しておくと、より自然な声になります）。')
})

test('the test command says it fell back to the Windows warning sound', async ($, on) => {
  const { beeps } = setup(on, ['terminal'], 'windows-silent')

  const { text } = await runTestCommand($)

  expect(beeps).toHaveLength(1)
  expect(text).toBe('テスト通知：トーストと Windows の警告音で知らせました（日本語の読み上げが使えないため）。')
})

test('starts PowerShell by its full path from the temp folder, wherever Claude Code was started', async ($, on) => {
  const { launches } = setup(on, ['terminal'], 'windows-voicevox')

  await runTestCommand($)

  expect(launches).toEqual([
    {
      executable: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      cwd: 'C:\\Users\\kenichi\\AppData\\Local\\Temp',
    },
  ])
})

test('calls the person by the name in the settings, without doubling さん', { options: { name: 'けんいちさん' } }, async ($, on) => {
  const { clock, spoken } = setup(on)

  await measure($, 85)
  await clock.settle()

  expect(spoken).toEqual([`けんいちさん、${ALERT}`])
})

test('says 明日の for a recovery tomorrow', async ($, on) => {
  const { clock, spoken } = setup(on)

  // 2026-10-08 01:20 JST
  await measure($, 85, '2026-10-07T16:20:00Z')
  await clock.settle()

  expect(spoken).toEqual(['5時間枠の残りが、20パーセントを切りましたよ。明日の1時20分に回復します。'])
})

test('names each window and its recovery when both drop below 20% together', async ($, on) => {
  const { clock, spoken, toasts } = setup(on)

  await measure($, 85, '2026-10-07T05:30:00Z', 90)
  await clock.settle()

  expect(toasts).toEqual(['⚠ 残量が20%を切りました：5時間 残り15% 14:30回復 ｜ 週間 残り10% 10/10 9:00回復'])
  expect(spoken).toEqual([
    '5時間枠と週間枠の残りが、20パーセントを切りましたよ。5時間枠は14時30分、週間枠は10月10日の9時に回復します。',
  ])
})

const runLogCommand = ($: Engine) =>
  $.command.run({
    command: 'usage-band-log',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

test('records each change of the windows in this month\'s CSV', async ($, on) => {
  const { files } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 10)
  await measure($, 30.5)

  expect(logOf(files)?.[1]).toBe(
    [
      LOG_HEADER,
      '2026-10-07T12:00:00+09:00,Wed,12,10,2026-10-07T14:30:00+09:00,45,2026-10-10T09:00:00+09:00',
      '2026-10-07T12:00:00+09:00,Wed,12,30.5,2026-10-07T14:30:00+09:00,45,2026-10-10T09:00:00+09:00',
      '',
    ].join('\n'),
  )
})

test('adds to the records already in the file', async ($, on) => {
  const { files } = setup(on, ['terminal'], 'windows-voicevox')
  const earlier = `${LOG_HEADER}\n2026-10-01T09:00:00+09:00,Thu,9,3,,40,\n`

  await measure($, 10)

  const [path = ''] = logOf(files) ?? []

  files.set(path, earlier)
  await measure($, 20)

  expect(files.get(path)?.startsWith(earlier)).toBe(true)
  expect(files.get(path)?.split('\n').filter(line => line !== '')).toHaveLength(3)
})

test('records nothing when the log setting is off', { options: { log: false } }, async ($, on) => {
  const { files } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 10)

  expect(files.size).toBe(0)
})

test('/usage-band-log tells where the file is and how many records it holds', async ($, on) => {
  setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 10)
  await measure($, 20)

  const { text } = await runLogCommand($)

  expect(text).toBe(
    `記録ファイル：${LOG_PATH}\n今月の記録：2 件\n中身を見るときは /usage-band-open を使うと、記録を止めずに見られます。`,
  )
})

const runOpenCommand = ($: Engine) =>
  $.command.run({
    command: 'usage-band-open',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

test('holds the rows while Excel has the log open, warns, and writes them once it is closed', async ($, on) => {
  const { files, locked, toasts } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 10)

  const [path = ''] = logOf(files) ?? []

  // Excel を開く
  locked.add(path)
  await measure($, 20)

  expect(files.get(path)?.split('\n').filter(line => line !== '')).toHaveLength(2)
  expect(toasts.at(-1)).toContain('Excel などで開かれているため')
  expect((await runLogCommand($)).text).toContain('書き込めずに取り置いている記録：1 件')

  // Excel を閉じる
  locked.delete(path)
  await measure($, 30)

  const rows = files.get(path)?.split('\n').filter(line => line !== '') ?? []

  expect(rows.slice(1).map(row => row.split(',')[3])).toEqual(['10', '20', '30'])
  expect((await runLogCommand($)).text).not.toContain('取り置いている')
})

test('/usage-band-open opens a copy of this month\'s log in Excel', async ($, on) => {
  const { opens } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 10)

  const { text } = await runOpenCommand($)

  expect(opens).toEqual([LOG_PATH])
  expect(text).toBe('記録のコピーを Excel で開きました。元のファイルは開いていないので、見ているあいだも記録は止まりません。')
})

test('/usage-band-open says when there is no log yet', async ($, on) => {
  setup(on, ['terminal'], 'windows-voicevox')

  const { text } = await runOpenCommand($)

  expect(text).toBe('まだ今月の記録ファイルがありません。残量が変わると記録が始まります。')
})

test('/usage-band-open says why the copy could not be opened', async ($, on) => {
  const { openFailure } = setup(on, ['terminal'], 'windows-voicevox')

  await measure($, 10)
  openFailure.message = 'アクセスが拒否されました。'

  const { text } = await runOpenCommand($)

  expect(text).toBe(`記録のコピーを開けませんでした（理由：アクセスが拒否されました。）。記録ファイル：${LOG_PATH}`)
})

const paneProps = (bodyColumns = 40) => ({
  title: '残量',
  isFocused: false,
  bodyColumns,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
})

const mountPane = ($: Engine, bodyColumns?: number) =>
  $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'Pane', requestId: 'usage-band', props: paneProps(bodyColumns) })

const phoneJoins = async ($: Engine, roster: RenderSurface[]) => {
  roster.push('mobile')
  await $.session.attach({ surface: 'mobile', clientId: 'phone' })
}

const phoneLeaves = async ($: Engine, roster: RenderSurface[]) => {
  roster.splice(roster.indexOf('mobile'), 1)
  await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
}

// the person typing a command of the plugin's, from the phone's narrow screen
const runCommand = ($: Engine, command: string) =>
  $.command.run({
    command,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 40 },
  })

test('/usage-band-now shows the meter as text, one window per line', async ($, on) => {
  setup(on, ['terminal'])
  await measure($, 72.5)

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH)
})

test('/usage-band-now says it is waiting before the first reading', async ($, on) => {
  setup(on, ['terminal'])

  expect((await runCommand($, 'usage-band-now')).text).toBe('残量: 取得待ち（Claude の返事が1回届くと表示できます）')
})

// 2026-10-07 14:30 JST and 10-10 09:00 JST, as the session holds them before the plugin has heard of them
const HELD = [
  { kind: 'five_hour', percentUsed: 72.5, resetsAt: '2026-10-07T05:30:00Z' },
  { kind: 'seven_day', percentUsed: 45, resetsAt: '2026-10-10T00:00:00Z' },
]

test('after a reload, /usage-band-now reads the figures the session already holds', async ($, on) => {
  const { held } = setup(on, ['terminal'])

  held.rateLimits = HELD

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH)
})

test('after a reload, takes the figures at the next measurement even when no window moved a whole point', async ($, on) => {
  setup(on, ['terminal'])

  await $.session.measure({ context: { window: 200_000, tokens: 1000 }, rateLimits: HELD, changed: ['context'] })

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH)
})

const AGE_NOTE = (age: string) => `\n（${age}に受け取った値です。Claude に話しかけると新しくなります）`

test('keeps the last figures when a reading comes back empty', async ($, on) => {
  setup(on, ['terminal'])

  await measure($, 72.5)
  await $.session.measure({ context: { window: 200_000, tokens: 1000 }, rateLimits: [], changed: ['rateLimits'] })

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH)
})

test('says how old the figures are when Claude Code holds none now', async ($, on) => {
  const { clock } = setup(on, ['terminal'])

  await measure($, 72.5)
  await $.session.measure({ context: { window: 200_000, tokens: 1000 }, rateLimits: [], changed: ['rateLimits'] })
  await clock.advance(30 * 60 * 1000)

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH + AGE_NOTE('30分前'))
})

test('says nothing of age while Claude Code holds the figures now', async ($, on) => {
  const { clock, held } = setup(on, ['terminal'])

  await measure($, 72.5)
  await clock.advance(30 * 60 * 1000)
  held.rateLimits = HELD

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH)
})

test('after a restart, shows the figures kept from before, saying how old they are', async ($, on) => {
  setup(on, ['terminal'], 'mac', { lastReading: { list: HELD, at: Date.parse('2026-10-07T01:00:00Z') } })

  expect((await runCommand($, 'usage-band-now')).text).toBe(BENEATH + AGE_NOTE('2時間前'))
})

test('shows a window whose reset has passed as full', async ($, on) => {
  const { clock } = setup(on, ['terminal'])

  await measure($, 72.5)
  await clock.advance(3 * 60 * 60 * 1000)

  expect((await runCommand($, 'usage-band-now')).text).toBe(
    ['残量', '🟢 5時間 █████ 100%', '🟢 週間 ███░░ 55% 10/10 9:00回復'].join('\n') + AGE_NOTE('3時間前'),
  )
})

test('records only when a window moved', async ($, on) => {
  const { files } = setup(on, ['terminal'], 'windows-voicevox')

  await $.session.measure({ context: { window: 200_000, tokens: 1000 }, rateLimits: HELD, changed: ['context'] })

  expect(logOf(files)).toBeUndefined()
})

test('while a phone is connected, adds the figures beneath each answer even where the band is drawn', async ($, on) => {
  const { roster } = setup(on, ['terminal'])

  await measure($, 72.5)
  await phoneJoins($, roster)

  expect((await completeTurn($)).text).toBe(BENEATH)

  await phoneLeaves($, roster)

  expect((await completeTurn($)).text).toBe('done')
})

test('does not open a pane when the phone joins, since the phone app draws none', async ($, on) => {
  const { roster, panesOpened } = setup(on, ['terminal'])

  await measure($, 72.5)
  await phoneJoins($, roster)

  expect(panesOpened).toEqual([])
})

test('/usage-band-pane opens the meter pane and puts the meter in its reply too', async ($, on) => {
  const { panesOpened } = setup(on, [])

  await measure($, 72.5)

  const { text } = await runCommand($, 'usage-band-pane')

  expect(panesOpened).toEqual(['usage-band'])
  expect(text).toBe(
    [
      '残量パネルを開きました。閉じるときは、パネルの閉じる印か Esc キーを使います。',
      'スマホのアプリにはパネルが出ないため、今の残量をここにも出します（/usage-band-now でいつでも見られます）。',
      BENEATH,
    ].join('\n'),
  )
})

test('the pane draws one window per line', async ($, on) => {
  setup(on, [])
  await measure($, 6)

  const pane = await mountPane($)

  expect(await pane.find({ text: /^5時間 █████████░ 94% 14:30回復$/ })).toBeDefined()
  expect(await pane.find({ text: /^週間 ██████░░░░ 55% 10\/10 9:00回復$/ })).toBeDefined()
  await pane.unmount()
})

test('halves the bars in a narrow pane', async ($, on) => {
  setup(on, [])
  await measure($, 6)

  const pane = await mountPane($, 30)

  expect(await pane.find({ text: /^5時間 █████ 94% 14:30回復$/ })).toBeDefined()
  await pane.unmount()
})

test('while the pane shows the meter, leaves the status line and the answers alone', async ($, on) => {
  const { statuses } = setup(on, [])

  await measure($, 72.5)
  expect(statuses.at(-1)).toBe(STATUS)

  await runCommand($, 'usage-band-pane')

  expect(statuses.at(-1)).toBeUndefined()
  expect((await completeTurn($)).text).toBe('done')
})

test('does not call anyone when the name is set to なし', { options: { name: 'なし' } }, async ($, on) => {
  const { clock, spoken } = setup(on)

  await measure($, 85)
  await clock.settle()

  expect(spoken).toEqual([ALERT])
})
