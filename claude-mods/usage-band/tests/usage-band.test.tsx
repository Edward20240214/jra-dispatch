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

// 2026-10-07 12:00 JST; what the engine answers beneath the plugin
const setup = (on: On, surfaces: readonly RenderSurface[] = ['terminal']) => {
  const statuses: (string | undefined)[] = []

  mock.clock(on, { now: Date.parse('2026-10-07T03:00:00Z') })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return statuses
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
  const statuses = setup(on, [])

  await measure($, 72.5)

  expect(statuses.at(-1)).toBe(STATUS)
})

test('without a surface that draws the band, adds the figures beneath each answer', async ($, on) => {
  setup(on, [])
  await measure($, 72.5)

  expect((await completeTurn($)).text).toBe(BENEATH)
})

test('on the terminal, leaves the status line and the answer alone', async ($, on) => {
  const statuses = setup(on, ['terminal'])

  await measure($, 72.5)

  expect(statuses.at(-1)).toBeUndefined()
  expect((await completeTurn($)).text).toBe('done')
})
