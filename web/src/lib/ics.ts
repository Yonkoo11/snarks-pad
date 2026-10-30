// The payout as a calendar entry: one VEVENT built from the engine's own nextEpochAt timestamp,
// nothing invented. The file carries the value at the moment of the click; if the round moves,
// the magnet is dropped again. Dates are UTC, as the spec wants them.
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export function payoutIcs(nextAt: string): string {
  const start = new Date(nextAt)
  const end = new Date(start.getTime() + 15 * 60_000)
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SNARKS pad//payout//EN',
    'BEGIN:VEVENT',
    `UID:snarks-payout-${start.getTime()}@snarks.fun`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    'SUMMARY:SNARKS pad payout round',
    "DESCRIPTION:The round claims the pools' fees and pays holders. Every round is on https://snarks.fun/#/payouts",
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

/** Hands the browser the .ics; the calendar app takes it from there. */
export function downloadPayoutIcs(nextAt: string): void {
  const url = URL.createObjectURL(new Blob([payoutIcs(nextAt)], { type: 'text/calendar' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'snarks-payout.ics'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
