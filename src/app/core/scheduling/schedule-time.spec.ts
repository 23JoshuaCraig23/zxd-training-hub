import { CENTRAL_EUROPE_TIMEZONE, SCHOOL_TIMEZONE, buildDefaultSchedule, formatInZone, zonedDateTime } from './schedule-time';

describe('schedule timezone architecture', () => {
  it('preserves New York noon through the US/Europe DST mismatch', () => {
    const start = zonedDateTime('2026-03-16', '12:00', SCHOOL_TIMEZONE);
    expect(start.toISOString()).toBe('2026-03-16T16:00:00.000Z');
    expect(formatInZone(start, CENTRAL_EUROPE_TIMEZONE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).toBe('17:00');
  });

  it('generates each weekday class and seven private slots per weekday', () => {
    const events = buildDefaultSchedule(new Date('2026-08-17T00:00:00Z'), new Date('2026-08-21T00:00:00Z'));
    expect(events.filter((event) => event.type === 'online_class')).toHaveLength(5);
    expect(events.filter((event) => event.type === 'hybrid_class')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'private_lesson')).toHaveLength(35);
  });
});
