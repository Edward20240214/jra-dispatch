import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const STATUS = '残量 ｜ 🟡 5時間 ███░░░░░░░ 28% 14:30回復 ｜ 🟢 週間 ██████░░░░ 55% 10/10 9:00回復'

const BENEATH = ['残量', '🟡 5時間 ███░░░░░░░ 28% 14:30回復', '🟢 週間 ██████░░░░ 55% 10/10 9:00回復'].join('\n')

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

const WINDOWS_ENV: Record<string, string> = { SystemRoot: 'C:\\WINDOWS', TEMP: 'C:\\Users\\kenichi\\AppData\\Local\\Temp' }

// 2026-10-07 12:00 JST; what the engine answers beneath the plugin
const setup = (on: On, surfaces: readonly RenderSurface[] = ['terminal'], host: Host = 'mac') => {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const spoken: string[] = []
  const voiceScripts: { text?: string; voice?: string }[] = []
  const beeps: (readonly string[])[] = []
  const launches: { executable?: string; cwd?: string }[] = []

  const clock = mock.clock(on, { now: Date.parse('2026-10-07T03:00:00Z') })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.surfaces', () => ({ value: surfaces }))
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
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return { clock, statuses, toasts, spoken, voiceScripts, beeps, launches }
}

// 5時間枠は 2026-10-07 14:30 JST、週間枠は 2026-10-10 09:00 JST にリセット
const measure = ($: Engine, percentUsed: number, fiveHourResetsAt = '2026-10-07T05:30:00Z') =>
  $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed, resetsAt: fiveHourResetsAt },
      { kind: 'seven_day', percentUsed: 45, resetsAt: '2026-10-10T00:00:00Z' },
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

const ALERT = '5時間枠の残りが、20パーセントを切りました。'
const TEST_SPEECH = '通知のテストです。残量が20パーセントを切ると、このようにお知らせします。'

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
  expect(voiceScripts).toEqual([{ text: TEST_SPEECH, voice: '冥鳴ひまり' }])
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
