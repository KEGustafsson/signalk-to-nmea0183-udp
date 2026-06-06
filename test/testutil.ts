import * as Bacon from 'baconjs'
import type { Conversion } from '../src/types/plugin'
// Side-effect import: patches dgram so the plugin's UDP socket forwards
// datagrams to the sink set below instead of the network.
import { setUdpSink } from './fakeUdp'

type OnEmit = (name: string, value: unknown) => void

interface TestApp {
  streambundle: {
    getSelfStream: (path: string) => Bacon.Bus<unknown>
  }
  debug: (msg: unknown) => void
  getSelfPath: (path: string) => { value: unknown } | null
}

/**
 * Build a stub Signal K `app` and start the plugin against it.
 *
 * The plugin sends NMEA0183 sentences over UDP; the test harness
 * intercepts those datagrams (see ./fakeUdp) and forwards each one to
 * `onEmit('nmea0183out', <sentence>)`. The leading event name is kept for
 * call-site compatibility — every datagram is a single NMEA0183 sentence,
 * trimmed of the trailing CR LF the plugin appends.
 *
 * `enabledConversion` accepts three forms so test files can stay terse:
 *   - string: shorthand for a single conversion `[{ sentence: string }]`
 *   - array:  new-format `conversions` array
 *   - object: full options (legacy flat-boolean form or `{ conversions }`)
 */
export function createAppWithPlugin(
  onEmit: OnEmit,
  enabledConversion: string | Conversion[] | Record<string, unknown>
): TestApp {
  const streams: Record<string, Bacon.Bus<unknown>> = {}
  const app: TestApp = {
    streambundle: {
      getSelfStream: (p: string): Bacon.Bus<unknown> => {
        const existing = streams[p]
        if (existing) return existing
        const bus = new Bacon.Bus<unknown>()
        streams[p] = bus
        return bus
      }
    },
    debug: (msg: unknown): void => {
      console.log(msg)
    },
    getSelfPath: () => null
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = require('../src/index')(app)

  let options: Record<string, unknown>
  if (typeof enabledConversion === 'string') {
    options = { conversions: [{ sentence: enabledConversion }] }
  } else if (Array.isArray(enabledConversion)) {
    options = { conversions: enabledConversion }
  } else {
    options = enabledConversion
  }

  // Route this plugin instance's datagrams to the test's onEmit. The fake
  // socket captures the sink when start() creates it, so set it right
  // before start(). Sentences arrive with a trailing CR LF; strip it so
  // assertions can compare against the bare sentence.
  setUdpSink((message) => onEmit('nmea0183out', message.replace(/\r\n$/, '')))
  try {
    plugin.start(options)
  } finally {
    setUdpSink(null)
  }
  return app
}
