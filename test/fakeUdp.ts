/**
 * Test seam for the plugin's UDP output.
 *
 * The plugin sends every NMEA0183 sentence with `dgram` via
 * `dgram.createSocket('udp4').send(...)`. Importing this module (for its
 * side effect) monkey-patches `dgram.createSocket` so the socket the
 * plugin creates is a fake that forwards each datagram to the sink
 * registered with `setUdpSink`, instead of putting bytes on the wire.
 *
 * `src/index.ts` does `import * as dgram from 'dgram'`, which compiles to
 * `require('dgram')` — the same cached module object patched here — and
 * calls `dgram.createSocket(...)` lazily inside `start()`, so the patch is
 * in effect by the time a test starts the plugin.
 *
 * The sink is captured at `createSocket` time (i.e. when `start()` runs),
 * so setting it immediately before `plugin.start()` routes that socket's
 * datagrams to the right test, even though the module-level pointer is
 * shared. Node is single-threaded and `start()` is synchronous, so there
 * is no interleaving between setting the sink and the socket capturing it.
 *
 * When no sink is set the patch is transparent: it delegates to the real
 * `dgram.createSocket`, so a genuine end-to-end UDP test (test/udp.ts)
 * still gets real sockets on the wire.
 *
 * The patch is applied to the CommonJS `dgram` module object obtained via
 * `require` rather than to an `import * as dgram` namespace: tsx compiles
 * the namespace to a getter-only object that cannot be reassigned, while
 * the underlying module's `createSocket` is writable. `src/index.ts`'s
 * `import * as dgram` reads `createSocket` from that same module live, so
 * it sees the patch.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dgram = require('dgram') as typeof import('dgram')

export type UdpSink = (message: string) => void

let currentSink: UdpSink | null = null

// Captured before patching so we can delegate when no sink is registered.
const realCreateSocket = dgram.createSocket.bind(dgram)

export function setUdpSink(sink: UdpSink | null): void {
  currentSink = sink
}

interface FakeSocket {
  send(message: unknown, ...rest: unknown[]): void
  close(cb?: () => void): void
  on(): FakeSocket
  unref(): FakeSocket
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dgram as any).createSocket = function createFakeSocket(
  ...args: unknown[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): FakeSocket | any {
  // Bind the sink at creation time so the datagrams from this socket reach
  // the test that started the plugin, regardless of later sink changes.
  const sink = currentSink
  // No sink registered → behave as the real dgram module (used by the
  // genuine end-to-end UDP test).
  if (!sink) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realCreateSocket as any)(...args)
  }
  const socket: FakeSocket = {
    send(message: unknown, ...rest: unknown[]): void {
      const cb = rest.find((a) => typeof a === 'function') as
        | ((err: Error | null) => void)
        | undefined
      if (sink) {
        const text = Buffer.isBuffer(message)
          ? message.toString('utf8')
          : String(message)
        sink(text)
      }
      if (cb) cb(null)
    },
    close(cb?: () => void): void {
      if (cb) cb()
    },
    on(): FakeSocket {
      return socket
    },
    unref(): FakeSocket {
      return socket
    }
  }
  return socket
}
