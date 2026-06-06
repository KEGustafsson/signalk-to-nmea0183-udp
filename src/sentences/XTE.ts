/*
Cross-track error:
$IIXTE,A,A,x.x,a,N,A*hh
 I_Cross-track error in miles, L= left, R= right
 */
import * as nmea from '../nmea'
import type { SentenceEncoder, SignalKApp } from '../types/plugin'

export default function (_app: SignalKApp): SentenceEncoder<[number]> {
  return {
    title: 'XTE - Cross-track error (w.r.t. server-configured calcMethod)',
    keys: ['navigation.course.calcValues.crossTrackError'],
    f: function (crossTrackError: number): string {
      return nmea.toXteSentence(crossTrackError)
    }
  }
}
