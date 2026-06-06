# Change Log

## v1.0.0

Initial release of `signalk-to-nmea0183-udp`, a UDP-output variant of
[`signalk-to-nmea0183`](https://github.com/KEGustafsson/signalk-to-nmea0183).

- Sends the selected NMEA 0183 sentences to a configurable UDP socket
  (default `127.0.0.1:10110`); each sentence is a single datagram
  terminated with `CR LF`.
- Removed all other output paths: no `nmea0183out` event, no per-sentence
  `g<SENTENCE>` events, and no custom-event output. The UDP socket is the
  only output.
- Added **UDP address** / **UDP port** fields to the configuration panel
  and schema; dropped the per-conversion **Custom event name** field.

All sentence encoders are inherited unchanged from the upstream plugin.
