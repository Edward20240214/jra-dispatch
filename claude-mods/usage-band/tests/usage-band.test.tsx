import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const props = (hasSurvey = false) => ({
  hasSurvey,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
})

// 2026-10-07 12:00 JST; the engine's own echo of session.measure beneath the plugin
const setup = (on: On) => {
  mock.clock(on, { now: Date.parse('2026-10-07T03:00:00Z') })
  on('session.measure', ($, e) => ({ changed: e.changed }))
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
