import { CalendarEvent } from '../models/scheduling.models';

export const SCHOOL_TIMEZONE = 'America/New_York' as const;
export const PACIFIC_TIMEZONE = 'America/Los_Angeles';
export const CENTRAL_EUROPE_TIMEZONE = 'Europe/Berlin';
export const DEFAULT_INSTRUCTOR_ID = 'nyc-school';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIVATE_STARTS = ['08:00', '09:00', '10:00', '11:00', '15:00', '16:00', '17:00'];

function partsAt(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

export function zonedDateTime(dateKey: string, time: string, timeZone = SCHOOL_TIMEZONE): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = wallClockUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const shown = partsAt(new Date(candidate), timeZone);
    const shownAsUtc = Date.UTC(shown['year'], shown['month'] - 1, shown['day'], shown['hour'], shown['minute']);
    candidate -= shownAsUtc - wallClockUtc;
  }
  return new Date(candidate);
}

export function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function addCalendarDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function calendarDateToday(): Date {
  const school = partsAt(new Date(), SCHOOL_TIMEZONE);
  return new Date(Date.UTC(school['year'], school['month'] - 1, school['day']));
}

export function buildDefaultSchedule(windowStart: Date, windowEnd: Date): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (let cursor = windowStart; cursor <= windowEnd; cursor = new Date(cursor.getTime() + DAY_MS)) {
    const weekday = cursor.getUTCDay();
    if (weekday < 1 || weekday > 5) continue;
    const day = dateKey(cursor);

    events.push(eventFor({
      id: `daytime_${day}`,
      productId: 'daytime-online-class',
      type: 'online_class',
      title: 'Daytime Online Class',
      description: 'Recurring weekday group training in Zhong Xin Dao I Liq Chuan principles and practice.',
      dateKey: day,
      startTime: '12:00',
      endTime: '13:30',
      attendanceModes: ['online'],
      priceCents: 2800,
      capacity: 30,
      recurrenceId: 'daytime-weekdays',
    }));

    if (weekday === 3) {
      events.push(eventFor({
        id: `wednesday-evening_${day}`,
        productId: 'wednesday-evening-class',
        type: 'hybrid_class',
        title: 'Wednesday Evening Manhattan Class',
        description: 'In-person Manhattan training with a live Zoom attendance option for remote students.',
        dateKey: day,
        startTime: '18:00',
        endTime: '21:00',
        attendanceModes: ['in_person', 'online'],
        priceCents: 4000,
        inPersonCapacity: 24,
        locationName: 'Manhattan training space',
        address: 'Manhattan, New York, NY',
        mapUrl: 'https://www.google.com/maps/search/?api=1&query=Manhattan%2C+New+York%2C+NY',
        recurrenceId: 'wednesday-evening',
      }));
    }

    for (const startTime of PRIVATE_STARTS) {
      const endTime = `${startTime.slice(0, 3)}50`;
      const slotId = `${DEFAULT_INSTRUCTOR_ID}_${day}_${startTime.replace(':', '-')}`;
      events.push(eventFor({
        id: `private_${slotId}`,
        productId: 'private-lesson',
        type: 'private_lesson',
        title: 'Private Lesson',
        description: 'A focused 50-minute lesson followed by a protected 10-minute instructor transition period.',
        dateKey: day,
        startTime,
        endTime,
        attendanceModes: ['in_person', 'online'],
        priceCents: 12000,
        capacity: 1,
        slotId,
        recurrenceId: 'private-weekdays',
      }));
    }
  }
  return [...events, ...defaultWorkshop(windowStart, windowEnd)].sort((a, b) => a.start.getTime() - b.start.getTime());
}

function eventFor(input: Omit<CalendarEvent, 'start' | 'end' | 'timezone' | 'instructorId' | 'instructorName' | 'status'>): CalendarEvent {
  return {
    ...input,
    start: zonedDateTime(input.dateKey, input.startTime),
    end: zonedDateTime(input.dateKey, input.endTime),
    timezone: SCHOOL_TIMEZONE,
    instructorId: DEFAULT_INSTRUCTOR_ID,
    instructorName: 'Zhong Xin Dao NYC Instructor',
    status: 'scheduled',
  };
}

function defaultWorkshop(windowStart: Date, windowEnd: Date): CalendarEvent[] {
  let saturday = addCalendarDays(calendarDateToday(), 18);
  while (saturday.getUTCDay() !== 6) saturday = addCalendarDays(saturday, 1);
  if (saturday < windowStart || saturday > windowEnd) return [];
  const sunday = addCalendarDays(saturday, 1);
  const productId = 'mindfulness-in-motion-weekend';
  const sessionIds = [`${productId}_${dateKey(saturday)}`, `${productId}_${dateKey(sunday)}`];
  return [saturday, sunday].map((day, index) => eventFor({
    id: sessionIds[index], productId, type: 'workshop', title: 'Mindfulness in Motion Workshop',
    description: 'A two-day workshop connecting awareness, structure, and change. One registration covers both sessions.',
    dateKey: dateKey(day), startTime: '13:30', endTime: '18:30', attendanceModes: ['in_person'],
    priceCents: 18500, memberPriceCents: 15500, capacity: 36,
    locationName: 'Manhattan training space', address: 'Manhattan, New York, NY', workshopSessionIds: sessionIds,
  }));
}

export function formatInZone(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
}
