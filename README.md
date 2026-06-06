# signalk-to-nmea0183-udp

Signal K server plugin that converts Signal K deltas into NMEA 0183
sentences and **sends them to a UDP socket** at a configurable address
and port. A per-sentence throttle lets you cap the send rate in
milliseconds so downstream NMEA 0183 consumers don't get flooded.

This is a UDP-output variant of
[`signalk-to-nmea0183`](https://github.com/KEGustafsson/signalk-to-nmea0183).
Unlike the upstream plugin, it does **not** publish on the server's event
bus (`nmea0183out`), per-sentence events, or custom events, so the
generated sentences never reach the server's built-in NMEA 0183 TCP/UDP
servers (e.g. the default port `10110`). The single output path is the
UDP socket configured in the plugin.

## Installation

From the command line in your `~/.signalk` dir:

```sh
npm install signalk-to-nmea0183-udp
```

Requires [signalk-server](https://github.com/SignalK/signalk-server)
with Node `>=20.10`.

> For **NMEA 2000 AIS → NMEA 0183** conversion use
> [`signalk-n2kais-to-nmea0183`](https://github.com/SignalK/signalk-n2kais-to-nmea0183)
> instead. This plugin does not emit AIS sentences.

## Usage

1. Enable the plugin in the server admin UI (_Server → Plugin Config →
   Convert Signal K to NMEA0183 (UDP)_).
2. Set the **UDP output** destination:
   - **UDP address** — destination IP address or hostname
     (default `127.0.0.1`).
   - **UDP port** — destination UDP port (default `10110`).
3. Add a row per sentence you want sent. Each row shows the required
   Signal K paths with live availability icons (✅ has data, ❓ value is
   null, ❌ not present) so you can see at a glance what is wired up.
4. Point any NMEA 0183 UDP client at the configured address/port. Each
   sentence is sent as a single UDP datagram terminated with `CR LF`.

Per conversion you can optionally set a **Minimum interval (ms)** to
throttle high-frequency sentences (`0` sends on every source update).

A quick way to watch the output:

```sh
nc -ul 10110        # or: socat -u UDP-RECV:10110 -
```

## Supported sentences

Each configured row selects one sentence and can have its own throttle
(ms). Leave the throttle at `0` to send on every source update.

### Course and waypoints

- **APB** — autopilot info, magnetic bearings (`--true` variant also
  available)
- **BWC** — bearing and distance to waypoint
- **RMB** — recommended minimum navigation info to waypoint
- **XTE** — cross-track error (`-GC` great-circle variant also available)

The waypoint identifier in these sentences is taken from the `name`
the Signal K server publishes on the active destination (the server
supplies its own `WP<n>` / `DP` / `VP` defaults). Servers that support
waypoint naming fill it; older servers leave the identifier fields
empty.

### Position, heading, speed

- **GLL** — geographic position, lat + lon
- **HDG / HDM / HDMC / HDT / HDTC** — heading variants (true /
  magnetic / deviation-corrected / magnetic-computed-from-true /
  true-computed-from-magnetic)
- **ROT** — rate of turn
- **RMC** — recommended minimum navigation data
- **VHW** — speed and heading through water
- **VTG** — track made good and speed over ground
- **VLW** — cumulative / trip log

### Depth

- **DBK / DBS / DBT** — depth below keel / surface / transducer
- **DPT** — depth + transducer offset (`-surface` variant references
  water surface)

### Wind

- **MWD** — true wind direction + speed (reference: north)
- **MWV** — apparent (`MWVR`) and true (`MWVT`) wind relative to the
  vessel
- **VWR / VWT** — legacy relative / true wind angle + speed
- **VPW** — speed parallel to wind

### Environment

- **MMB** — barometric pressure
- **MTA** — air temperature
- **MTW** — water temperature
- **XDRBaro / XDRTemp / XDRNA** — transducer readings for barometric
  pressure, air temperature, and pitch + roll (`XDRNA`)

### Rudder and time

- **RSA** — rudder sensor angle
- **GGA** — GPS fix data with time
- **ZDA** — UTC date/time and time-zone offset

### Proprietary

- **PNKEP01 / PNKEP02 / PNKEP03 / PNKEP99** — NKE Marine Electronics
  performance sentences: target polar speed, course on the other tack,
  polar speed + VMG + optimum angle, debug
- **PSILCD1** — polar speed + target wind angle for
  Silva / Nexus / Garmin displays
- **PSILTBS** — Garmin proprietary target boat speed

## Development

`npm test` runs the full mocha suite; `npm run typecheck` +
`npm run build` guard the TypeScript surface; `npm run build:config`
bundles the React configuration panel; `npm run mutation` runs Stryker
against the encoders.

Adding a new sentence is a three-step change documented at the top of
[`src/sentences/index.ts`](src/sentences/index.ts): create a
`SentenceEncoderFactory`-shaped module under `src/sentences/`, import
it in the barrel, add tests under `test/`. `test/registry.ts` asserts
barrel-vs-directory parity so a missing import fails CI.

## License

Apache-2.0. See [LICENSE](LICENSE).

Derived from
[`signalk-to-nmea0183`](https://github.com/KEGustafsson/signalk-to-nmea0183)
(originally by teppo.kurki@iki.fi), Apache-2.0.
