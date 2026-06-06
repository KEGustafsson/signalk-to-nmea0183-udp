/**
 * End-to-end UDP output test.
 *
 * Unlike the other harness tests (which intercept the socket via
 * ./fakeUdp), this test exercises the real `dgram` path: it binds a real
 * loopback UDP receiver, points the plugin at it, and asserts the actual
 * datagram that arrives on the wire. Importing ./fakeUdp keeps the patch
 * transparent when no sink is registered, so the plugin and the receiver
 * here both get real sockets.
 */
import * as assert from 'assert'
import * as dgram from 'dgram'
import * as Bacon from 'baconjs'
import { setUdpSink } from './fakeUdp'

interface StubApp {
  streambundle: { getSelfStream: (p: string) => Bacon.Bus<unknown> }
  debug: (m: unknown) => void
  getSelfPath: () => null
}

describe('UDP output (end-to-end)', function () {
  this.timeout(5000)

  it('sends the generated sentence as a CR-LF-terminated datagram to the configured address/port', async function () {
    // Make sure the dgram patch is transparent for this test.
    setUdpSink(null)

    const receiver = dgram.createSocket('udp4')
    const port = await new Promise<number>((resolve, reject) => {
      receiver.once('error', reject)
      receiver.bind(0, '127.0.0.1', () => resolve(receiver.address().port))
    })

    const received = new Promise<string>((resolve) => {
      receiver.once('message', (msg) => resolve(msg.toString('utf8')))
    })

    const streams: Record<string, Bacon.Bus<unknown>> = {}
    const app: StubApp = {
      streambundle: {
        getSelfStream: (p: string): Bacon.Bus<unknown> => {
          if (!streams[p]) streams[p] = new Bacon.Bus<unknown>()
          return streams[p]!
        }
      },
      debug: (): void => {},
      getSelfPath: () => null
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plugin = require('../src/index')(app)
    plugin.start({
      udp: { address: '127.0.0.1', port },
      conversions: [{ sentence: 'DBT' }]
    })

    streams['environment.depth.belowTransducer']!.push(10)

    let timer: NodeJS.Timeout
    const timeout = new Promise<string>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out waiting for UDP datagram')),
        1500
      )
    })

    try {
      const datagram = await Promise.race([received, timeout])
      assert.strictEqual(
        datagram,
        '$IIDBT,32.8,f,10.00,M,5.5,F*29\r\n',
        'datagram should be the DBT sentence terminated with CR LF'
      )
    } finally {
      clearTimeout(timer!)
      plugin.stop()
      await new Promise<void>((resolve) => receiver.close(() => resolve()))
    }
  })
})
