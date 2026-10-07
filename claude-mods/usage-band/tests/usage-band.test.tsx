import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const LINE = '残り使用量  5時間枠 27.5%（14:30リセット）  週間枠 55%（10/10 9:00リセット）'

const props = (hasSurvey = false) => ({
  hasSurvey,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
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

const measure = ($: Engine, percentUsed: number) =>
  $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      // 2026-10-07 14:30 JST
      { kind: 'five_hour', percentUsed, resetsAt: '2026-10-07T05:30:00Z' },
      // 2026-10-10 09:00 JST
      { kind: 'seven_day', percentUsed: 45, resetsAt: '2026-10-10T00:00:00Z' },
    ],
    changed: ['rateLimits'],
  })

const completeTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

test('shows a waiting hint before the first reading', async ($, on) => {
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: props() })

    expect(await band.find({ text: /取得待ち/ })).toBeDefined()
    await band.unmount()
  }
})

test('shows remaining percent and reset time in JST after a measurement', async ($, on) => {
  setup(on)
  await measure($, 72.5)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: props() })

    expect(await band.find({ text: /5時間枠.*残り27\.5%.*14:30リセット/ })).toBeDefined()
    expect(await band.find({ text: /週間枠.*残り55%.*10\/10 9:00リセット/ })).toBeDefined()
    await band.unmount()
  }
})

test('redraws when a later measurement moves the window', async ($, on) => {
  setup(on)
  await measure($, 10)

  const band = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: props() })

  expect(await band.find({ text: /残り90%/ })).toBeDefined()

  await measure($, 85)

  expect(await band.find({ text: /残り15%/ })).toBeDefined()
  expect(await band.find({ text: /残り90%/ })).toBeUndefined()
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

  const band = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: props(true) })

  expect(await band.find({ text: /survey/ })).toBeDefined()
  expect(await band.find({ text: /残り使用量/ })).toBeUndefined()
  await band.unmount()
})

test('without a surface that draws the band, pins the figures on the status line', async ($, on) => {
  const statuses = setup(on, [])

  await measure($, 72.5)

  expect(statuses.at(-1)).toBe(LINE)
})

test('without a surface that draws the band, adds the figures beneath each answer', async ($, on) => {
  setup(on, [])
  await measure($, 72.5)

  expect((await completeTurn($)).text).toBe(LINE)
})

test('on the terminal, leaves the status line and the answer alone', async ($, on) => {
  const statuses = setup(on, ['terminal'])

  await measure($, 72.5)

  expect(statuses.at(-1)).toBeUndefined()
  expect((await completeTurn($)).text).toBe('done')
})
