import { describe, it, expect } from 'vitest'
import { isWithinSendWindow } from '../sms-rate-limit.js'

/**
 * The operator's send window: 8am through 7pm Central.
 *
 * Every assertion below is written as a UTC instant with the Central wall-clock
 * time it corresponds to, because that is the whole point — the rule is expressed
 * in LOCAL hours, and a server-local hour computation gets it wrong twice a year.
 *
 * The window matches the cron committed in 02646a3, which runs every 5 minutes
 * across hours 8 through 18 inclusive. In cron terms hour 18 is
 * the 6 o'clock hour, so the last tick fires 18:55 and sends land before 19:00.
 */
describe('isWithinSendWindow — the operator 8am-7pm Central rule', () => {
  // 2026-06-15 is CDT (UTC-5).
  const cdt = (hhmm) => new Date(`2026-06-15T${hhmm}:00Z`)

  it('is CLOSED at 07:59 Central', () => {
    expect(isWithinSendWindow({ now: cdt('12:59') })).toBe(false)
  })

  it('OPENS at 08:00 Central', () => {
    expect(isWithinSendWindow({ now: cdt('13:00') })).toBe(true)
  })

  it('is OPEN midday', () => {
    expect(isWithinSendWindow({ now: cdt('17:00') })).toBe(true)
  })

  it('is still OPEN at 18:55 Central — the last cron tick', () => {
    expect(isWithinSendWindow({ now: cdt('23:55') })).toBe(true)
  })

  it('is still OPEN at 18:59 Central — the final minute of hour 18', () => {
    expect(isWithinSendWindow({ now: cdt('23:59') })).toBe(true)
  })

  it('CLOSES at 19:00 Central — the operator 7pm cutoff', () => {
    expect(isWithinSendWindow({ now: new Date('2026-06-16T00:00:00Z') })).toBe(false)
  })

  it('is CLOSED late evening', () => {
    expect(isWithinSendWindow({ now: new Date('2026-06-16T04:30:00Z') })).toBe(false)
  })

  it('is CLOSED at 3am — the hour a STOP confirmation used to fire', () => {
    expect(isWithinSendWindow({ now: cdt('08:00') })).toBe(false)
  })

  // Winter: the SAME wall-clock hours must hold under CST (UTC-6). If the hour were
  // computed from the server's own clock rather than through Central Intl, these two
  // would drift by an hour and the window would silently move.
  it('holds under CST: 08:00 Central in January is open', () => {
    expect(isWithinSendWindow({ now: new Date('2026-01-15T14:00:00Z') })).toBe(true)
  })

  it('holds under CST: 07:59 Central in January is closed', () => {
    expect(isWithinSendWindow({ now: new Date('2026-01-15T13:59:00Z') })).toBe(false)
  })

  // DST transition days. 08:00 Central maps to a DIFFERENT UTC instant on each of
  // these, which is exactly the case a naive offset gets wrong.
  it('spring forward (2026-03-08): 08:00 Central is open, 07:59 is not', () => {
    expect(isWithinSendWindow({ now: new Date('2026-03-08T13:00:00Z') })).toBe(true)
    expect(isWithinSendWindow({ now: new Date('2026-03-08T12:59:00Z') })).toBe(false)
  })

  it('fall back (2026-11-01): 08:00 Central is open, 07:59 is not', () => {
    expect(isWithinSendWindow({ now: new Date('2026-11-01T14:00:00Z') })).toBe(true)
    expect(isWithinSendWindow({ now: new Date('2026-11-01T13:59:00Z') })).toBe(false)
  })

  it('the two DST days disagree about which UTC instant is 08:00 Central', () => {
    // Guards the assertions above from being accidentally identical: if this ever
    // fails, the dates chosen are no longer on opposite sides of a DST boundary
    // and the two tests above have stopped testing what they claim to.
    const springIsCdt = isWithinSendWindow({ now: new Date('2026-03-08T13:00:00Z') })
    const fallAtSameInstant = isWithinSendWindow({ now: new Date('2026-11-01T13:00:00Z') })
    expect(springIsCdt).toBe(true)
    expect(fallAtSameInstant).toBe(false)
  })
})
