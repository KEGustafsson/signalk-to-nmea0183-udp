/**
 * Core types for the signalk-to-nmea0183-udp plugin.
 *
 * `SignalKApp` is the public `ServerAPI` from `@signalk/server-api`. This
 * plugin sends its NMEA0183 output over a UDP socket rather than on the
 * host's event bus, so no `emit` method is required.
 *
 * `SentenceEncoder` is the shape every module in src/sentences/ returns.
 * Keys are Signal K paths; `f` is invoked with the latest value for each
 * path (in the same order as `keys`) and must return either an NMEA
 * sentence string or `undefined` to skip emission.
 *
 * `defaults[i]` is the seed used when the stream for `keys[i]` has not
 * emitted yet. Indexes without defaults remain non-property streams and
 * must emit at least once before the combined stream fires.
 */
import type { EventStream, Property } from 'baconjs'
import type { Plugin, ServerAPI } from '@signalk/server-api'

export type { StreamBundle } from '@signalk/server-api'

/** @internal */
export type AnyStream<T = unknown> = EventStream<T> | Property<T>

/**
 * The Signal K server API surface the plugin uses. This variant sends
 * NMEA0183 sentences over a UDP socket, so unlike the upstream plugin it
 * does not need the EventEmitter `emit` method and uses `ServerAPI`
 * directly.
 */
export type SignalKApp = ServerAPI

/**
 * A sentence encoder. Generic parameter `A` ties the arity of `f` to
 * the length of `keys` / `defaults` for encoders that opt in:
 *
 *   const enc: SentenceEncoder<[number, number, string]> = {
 *     keys: ['a', 'b', 'c'],
 *     f: (a, b, c) => ...
 *   }
 *
 * rejects a `keys` array of the wrong length or an `f` with a mismatched
 * signature at the type level. The default `readonly any[]` preserves
 * the loose shape the registry uses to iterate all encoders uniformly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SentenceEncoder<
  A extends readonly unknown[] = readonly any[]
> {
  sentence?: string
  title: string
  keys: { readonly [I in keyof A]: string }
  defaults?: { readonly [I in keyof A]?: A[I] }
  optionKey?: string
  f: (...args: A) => string | undefined
}

/** @internal */
export type SentenceEncoderFactory = (
  app: SignalKApp,
  plugin?: SignalKPlugin
) => SentenceEncoder

// Exposed because `SignalKPlugin.schema` references these; they would
// otherwise be stripped by `stripInternal` and leave a broken .d.ts.
//
// The plugin schema is JSON-Schema-shaped but only uses a handful of
// fields. `SignalKPluginSchemaProperty` covers both leaf properties
// (type/default) and the nested `array` shape used by the Active
// Conversions entry, so a single `Record<string, ...>` can hold the
// whole tree without a sum type per nesting level.
export interface SignalKPluginSchemaProperty {
  title?: string
  description?: string
  type?: string
  default?: unknown
  minimum?: number
  maximum?: number
  multipleOf?: number
  required?: string[]
  properties?: Record<string, SignalKPluginSchemaProperty>
  items?: SignalKPluginSchemaProperty
  oneOf?: Array<{ const: string; title: string }>
}

export interface SignalKPluginSchema {
  type: string
  title: string
  description: string
  properties: Record<string, SignalKPluginSchemaProperty>
}

/**
 * Shape of a single active conversion entry in the plugin's options.
 * `sentence` is the registry key (e.g. `'DBT'`, `'APB-true'`).
 * `throttle` is a minimum interval in ms (0/omitted = no throttling).
 */
export interface Conversion {
  sentence: string
  throttle?: number
}

/** UDP destination the generated NMEA0183 sentences are sent to. */
export interface UdpConfig {
  address?: string
  port?: number
}

/**
 * Options object passed to `plugin.start()`. `conversions` is the
 * canonical shape; legacy flat-boolean configs (`{ DBT: true,
 * DBT_throttle: 500 }`) are migrated at startup. `udp` configures the
 * destination address/port for the sentence datagrams.
 */
export interface PluginOptions {
  conversions?: Conversion[]
  udp?: UdpConfig
  [legacyKey: string]: unknown
}

/**
 * Shape of the plugin object returned to the signalk-server host.
 * Consumers normally don't construct this directly — they call the
 * factory exported by the package entry.
 *
 * `schema` is a function rather than a plain object so each call can
 * re-read live Signal K state (via `app.getSelfPath`) and annotate
 * sentence titles with path-availability indicators.
 */
export interface SignalKPlugin extends Plugin {
  schema: () => SignalKPluginSchema
  start: (config?: object, restart?: (newConfiguration: object) => void) => void
  sentences: Record<string, SentenceEncoder>
  unsubscribes: Array<() => void>
}
