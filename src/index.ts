/**
 * Signal K server plugin entry point.
 *
 * Combines Signal K streams into inputs for the encoders in
 * src/sentences/, then sends the resulting NMEA0183 sentences out over a
 * UDP socket to a configurable address and port.
 *
 * Unlike the upstream signalk-to-nmea0183 plugin, this variant does not
 * publish on the host's event bus (no `nmea0183out`, no per-sentence
 * `g<SENTENCE>` events, no custom events). The only output path is the
 * UDP socket, so sentences never reach the server's built-in NMEA0183
 * TCP/UDP servers (e.g. the default port 10110).
 */
import * as dgram from 'dgram'
import { sentenceFactories } from './sentences'
import type * as PluginTypes from './types/plugin'
import type { Path } from '@signalk/server-api'
import type { Property } from 'baconjs'

type AnyStream<T = unknown> = PluginTypes.AnyStream<T>
type Conversion = PluginTypes.Conversion
type PluginOptions = PluginTypes.PluginOptions
type SentenceEncoder = PluginTypes.SentenceEncoder
type SignalKApp = PluginTypes.SignalKApp
type SignalKPlugin = PluginTypes.SignalKPlugin
type SignalKPluginSchema = PluginTypes.SignalKPluginSchema

// Combine N streams into a single Property whose values are fn(v1, v2, ...vN),
// using only the instance-method .combine(other, fn) that exists on both
// baconjs 1.x and 3.x. Avoids require('baconjs') in the plugin so that
// the plugin never carries its own Bacon copy: all stream operations run on
// the Bacon instance the host signalk-server created the streams with.
//
// The seed of the reduce calls .toProperty() so the result is always a
// Property even when there is only one input stream (no .combine call to
// implicitly lift it). Downstream callers depend on .changes(), which is a
// Property-only method.
function combineStreamsWith(
  streams: AnyStream[],
  fn: (...args: unknown[]) => unknown
): Property<unknown> {
  // Seed the reduce with streams[0] lifted to a Property<unknown[]> so
  // the running accumulator never holds null. Iterate streams.slice(1)
  // and keep extending the tuple. The explicit `.reduce<...>` type
  // parameter pins the accumulator for baconjs's
  // EventStream|Property-union combine return; with it inferred to
  // `Property<unknown[]>`, no cast is needed in the reducer body.
  const first = streams[0]!.toProperty().map((v): unknown[] => [v])
  return streams
    .slice(1)
    .reduce<Property<unknown[]>>(
      (acc, stream) => acc.combine(stream, (arr, v) => arr.concat([v])),
      first
    )
    .map((args) => fn.apply(null, args))
}

// Unicode path-availability indicators used in schema titles. Also
// referenced by the React config panel (which parses the bracketed
// suffix back out of each oneOf title) and the schema-builder's
// legend, so they live as module-level constants.
const INDICATOR_OK = '\uD83D\uDC4D'
const INDICATOR_NULL = '\u274E'
const INDICATOR_MISSING = '\u274C'

// Default UDP destination for the generated NMEA0183 sentences. Sentences
// are sent as datagrams to this address/port; both are overridable from
// the plugin config. 10110 is the conventional NMEA0183-over-network port.
const DEFAULT_UDP_ADDRESS = '127.0.0.1'
const DEFAULT_UDP_PORT = 10110

function pathIndicator(app: SignalKApp, skPath: string): string {
  if (!app.getSelfPath) return INDICATOR_MISSING
  const p = app.getSelfPath(skPath)
  if (!p || typeof p !== 'object' || !('value' in p)) return INDICATOR_MISSING
  return (p as { value: unknown }).value === null
    ? INDICATOR_NULL
    : INDICATOR_OK
}

function buildSchema(
  app: SignalKApp,
  sentences: Record<string, SentenceEncoder>
): SignalKPluginSchema {
  const sentenceOptions = Object.keys(sentences)
    .sort()
    .map((key) => {
      const s = sentences[key]!
      const paths = s.keys
        .map((k) => `${k}(${pathIndicator(app, k)})`)
        .join(', ')
      return {
        const: key,
        title: `${s.title} [${paths}]`
      }
    })

  return {
    type: 'object',
    title: 'Conversions to NMEA0183 (UDP output)',
    description:
      'If there is SK data for the conversion generate the following NMEA0183 sentences from Signal K data and send them to the configured UDP socket. For converting NMEA2000 AIS to NMEA 0183 use the signalk-n2kais-to-nmea0183 plugin.',
    properties: {
      udp: {
        type: 'object',
        title: 'UDP output',
        description:
          'Destination the generated NMEA0183 sentences are sent to as UDP datagrams.',
        properties: {
          address: {
            type: 'string',
            title: 'UDP address',
            description: 'Destination IP address or hostname.',
            default: DEFAULT_UDP_ADDRESS
          },
          port: {
            type: 'number',
            title: 'UDP port',
            description: 'Destination UDP port.',
            default: DEFAULT_UDP_PORT
          }
        }
      },
      conversions: {
        type: 'array',
        title: 'Active Conversions',
        description: `Legend: ${INDICATOR_OK} path has data, ${INDICATOR_NULL} value is null, ${INDICATOR_MISSING} path not present`,
        items: {
          type: 'object',
          required: ['sentence'],
          properties: {
            sentence: {
              title: 'Sentence',
              type: 'string',
              oneOf: sentenceOptions
            },
            throttle: {
              title: 'Minimum interval (ms)',
              description:
                'Minimum milliseconds between sends. 0 or empty = no throttling.',
              type: 'number',
              default: 0
            }
          }
        }
      }
    }
  }
}

// Migrate a legacy flat-boolean options object to the array form. The
// plugin historically used `{ DBT: true, DBT_throttle: 500, ... }`; the
// new format is `{ conversions: [{ sentence: 'DBT', throttle: 500 }] }`.
// When the options object is already in the new shape this returns the
// existing array unchanged.
function resolveConversions(
  options: PluginOptions,
  sentences: Record<string, SentenceEncoder>,
  debug: (msg: unknown) => void
): Conversion[] {
  if (Array.isArray(options.conversions)) return options.conversions

  const migrated: Conversion[] = Object.keys(sentences)
    .filter((name) => options[name])
    .map((name) => {
      const throttleRaw = options[`${name}_throttle`]
      const throttle = typeof throttleRaw === 'number' ? throttleRaw : 0
      return { sentence: name, throttle }
    })

  if (migrated.length > 0) {
    debug(
      `Migrated ${migrated.length} legacy conversion(s). Re-save the plugin config to complete migration.`
    )
  }
  return migrated
}

const createPlugin = function (app: SignalKApp): SignalKPlugin {
  // The UDP socket sentences are sent on. Created in start(), torn down
  // in stop(). Held in closure scope so both lifecycle hooks share it.
  let socket: dgram.Socket | undefined

  const plugin: SignalKPlugin = {
    id: 'sk-to-nmea0183-udp',
    name: 'Convert Signal K to NMEA0183 (UDP)',
    description: 'Plugin to convert Signal K to NMEA0183 and send it over UDP',
    // Schema is a function so each call re-reads live Signal K state
    // via `app.getSelfPath` and annotates sentence titles with current
    // path-availability indicators.
    schema: () => buildSchema(app, plugin.sentences),
    unsubscribes: [],
    sentences: {},
    start: function (options: PluginOptions): void {
      const udpAddress = options.udp?.address || DEFAULT_UDP_ADDRESS
      const udpPort = options.udp?.port ?? DEFAULT_UDP_PORT

      const sock = dgram.createSocket('udp4')
      // Don't let the socket keep the host process alive on its own.
      sock.unref()
      sock.on('error', (err: Error) => {
        console.error(`sk-to-nmea0183-udp: socket error: ${err.message}`)
      })
      socket = sock

      // Send one NMEA0183 sentence as a UDP datagram. Sentences are
      // terminated with CR LF so the receiver can frame them, matching how
      // NMEA0183 is carried over a network link.
      function sendUdp(nmeaString: string): void {
        const datagram = Buffer.from(`${nmeaString}\r\n`)
        sock.send(datagram, udpPort, udpAddress, (err) => {
          if (err) {
            console.error(`sk-to-nmea0183-udp: send failed: ${err.message}`)
          }
        })
      }

      function mapToNmea(encoder: SentenceEncoder, throttle: number): void {
        const selfStreams = encoder.keys.map((key, index) => {
          let stream: AnyStream = app.streambundle.getSelfStream(key as Path)
          if (
            encoder.defaults &&
            typeof encoder.defaults[index] !== 'undefined'
          ) {
            stream = stream.toProperty(encoder.defaults[index]) as AnyStream
          }
          return stream
        })

        let stream = combineStreamsWith(
          selfStreams,
          function (this: unknown, ...args: unknown[]) {
            try {
              return encoder.f.apply(this, args)
            } catch (e) {
              console.error((e as Error).message)
              return undefined
            }
          }
        )
          .filter((v) => typeof v !== 'undefined')
          .changes()
          .debounceImmediate(20)

        if (throttle > 0) {
          stream = stream.throttle(throttle)
        }

        plugin.unsubscribes.push(
          stream.onValue((nmeaString) => {
            if (app.reportOutputMessages) {
              app.reportOutputMessages(1)
            }
            sendUdp(nmeaString as string)
            app.debug(nmeaString)
          })
        )
      }

      const conversions = resolveConversions(
        options,
        plugin.sentences,
        app.debug
      )

      app.debug(
        `Sending NMEA0183 over UDP to ${udpAddress}:${udpPort} ` +
          `(${conversions.length} conversion(s))`
      )

      conversions.forEach((conv) => {
        const encoder = plugin.sentences[conv.sentence]
        if (!encoder) {
          console.error(
            'sk-to-nmea0183-udp: unknown sentence "%s", skipping',
            conv.sentence
          )
          return
        }
        mapToNmea(encoder, conv.throttle ?? 0)
      })
    },
    stop: function (): void {
      plugin.unsubscribes.forEach((f) => f())
      plugin.unsubscribes = []
      if (socket) {
        socket.close()
        socket = undefined
      }
    }
  }

  plugin.sentences = loadSentences(app, plugin)
  return plugin
}

// `export = createPlugin` emits `module.exports = createPlugin` so the
// signalk-server plugin loader (plain CJS `require(...)`) continues to
// receive the factory directly. The `export =` form (vs the older
// `module.exports = ...` assignment) gives tsc a concrete symbol to
// emit into the `.d.ts`, so consumers importing the plugin see the
// real `(app: SignalKApp) => SignalKPlugin` signature instead of the
// opaque `export {}` the older pattern produced.
//
// A namespace merge on the same identifier re-exports the companion
// types from the package root. `export =` forbids named exports, so
// this is the canonical way to make
//   import type { SignalKPlugin } from 'signalk-to-nmea0183-udp'
// work without forcing consumers into brittle subpath imports.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace createPlugin {
  export type SignalKApp = PluginTypes.SignalKApp
  export type SignalKPlugin = PluginTypes.SignalKPlugin
  export type SentenceEncoder<
    A extends readonly unknown[] = readonly any[] // eslint-disable-line @typescript-eslint/no-explicit-any
  > = PluginTypes.SentenceEncoder<A>
  export type StreamBundle = PluginTypes.StreamBundle
  export type SignalKPluginSchema = PluginTypes.SignalKPluginSchema
  export type SignalKPluginSchemaProperty =
    PluginTypes.SignalKPluginSchemaProperty
  export type Conversion = PluginTypes.Conversion
  export type UdpConfig = PluginTypes.UdpConfig
  export type PluginOptions = PluginTypes.PluginOptions
}

export = createPlugin

function loadSentences(
  app: SignalKApp,
  plugin: SignalKPlugin
): Record<string, SentenceEncoder> {
  // Static barrel import (`./sentences/index.ts`) replaces the previous
  // runtime `readdirSync + require` scan. tsc proves at compile time
  // that every entry matches `SentenceEncoderFactory`, and the plugin
  // boots without any filesystem I/O — noticeable on Cerbo-class hosts.
  const acc: Record<string, SentenceEncoder> = {}
  for (const name of Object.keys(sentenceFactories)) {
    acc[name] = sentenceFactories[name]!(app, plugin)
  }
  return acc
}
