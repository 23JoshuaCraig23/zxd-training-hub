import { Injectable, inject, signal } from '@angular/core';
import { collection, getDocs, query, Timestamp, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AdminScheduleCounts, CalendarEvent, ScheduleRegistrationResult } from '../models/scheduling.models';
import { SCHOOL_TIMEZONE, addCalendarDays, buildDefaultSchedule, calendarDateToday, dateKey, zonedDateTime } from '../scheduling/schedule-time';
import { FirebaseService } from './firebase.service';

@Injectable({ providedIn: 'root' })
export class SchedulingService {
  private readonly firebase = inject(FirebaseService);
  readonly events = signal<CalendarEvent[]>([]);
  readonly loading = signal(false);

  async loadWindow(anchor = calendarDateToday()): Promise<void> {
    this.loading.set(true);
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
    const end = addCalendarDays(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 3, 0)), 1);
    let events = buildDefaultSchedule(start, end).filter((event) => event.type !== 'private_lesson' || event.start.getTime() > Date.now() + 15 * 60 * 1000);

    try {
    if (this.firebase.firestore) {
      const [recurring, occurrences, workshops, availability] = await Promise.all([
        getDocs(collection(this.firebase.firestore, 'recurringSchedules')),
        getDocs(query(collection(this.firebase.firestore, 'eventOccurrences'), where('dateKey', '>=', dateKey(start)), where('dateKey', '<=', dateKey(end)))),
        getDocs(query(collection(this.firebase.firestore, 'workshops'), where('status', '==', 'published'))),
        getDocs(collection(this.firebase.firestore, 'privateLessonAvailability')),
      ]);

      for (const schedule of recurring.docs) {
        const data = schedule.data() as { status?: string; title?: string; startTime?: string; endTime?: string; priceCents?: number; weekdays?: number[]; type?: CalendarEvent['type']; attendanceModes?: CalendarEvent['attendanceModes']; description?: string };
        if (data.status === 'cancelled') {
          events = events.filter((event) => event.recurrenceId !== schedule.id);
          continue;
        }
        const existing = events.filter((event) => event.recurrenceId === schedule.id);
        if (existing.length) {
          events = events.map((event) => event.recurrenceId !== schedule.id ? event : {
            ...event,
            title: data.title ?? event.title,
            startTime: data.startTime ?? event.startTime,
            endTime: data.endTime ?? event.endTime,
            start: zonedDateTime(event.dateKey, data.startTime ?? event.startTime),
            end: zonedDateTime(event.dateKey, data.endTime ?? event.endTime),
            priceCents: data.priceCents ?? event.priceCents,
          });
          continue;
        }
        if (!data.weekdays?.length || !data.startTime || !data.endTime || !data.type || !data.attendanceModes?.length) continue;
        for (let cursor = start; cursor <= end; cursor = addCalendarDays(cursor, 1)) {
          if (!data.weekdays.includes(cursor.getUTCDay())) continue;
          const day = dateKey(cursor);
          events.push({
            id: `${schedule.id}_${day}`, productId: schedule.id, recurrenceId: schedule.id,
            type: data.type, title: data.title ?? 'Recurring Class', description: data.description ?? '',
            start: zonedDateTime(day, data.startTime), end: zonedDateTime(day, data.endTime), timezone: SCHOOL_TIMEZONE,
            instructorId: 'nyc-school', instructorName: 'Zhong Xin Dao NYC Instructor', attendanceModes: data.attendanceModes,
            priceCents: data.priceCents ?? 0, status: 'scheduled', dateKey: day, startTime: data.startTime, endTime: data.endTime,
          });
        }
      }

      const cancelled = new Set(occurrences.docs.filter((doc) => doc.get('status') === 'cancelled').map((doc) => doc.id));
      const overrides = availability.docs.map((doc) => ({ id: doc.id, ...(doc.data() as { action: string; startDate: string; endDate: string; startTime?: string; instructorId?: string; attendanceModes?: CalendarEvent['attendanceModes'] }) }));
      events = events.filter((event) => {
        if (cancelled.has(event.id)) return false;
        if (event.type !== 'private_lesson') return true;
        const exactId = `${event.instructorId}_${event.dateKey}_${event.startTime.replace(':', '-')}`;
        const dayId = `${event.instructorId}_${event.dateKey}`;
        const active = overrides.find((item) => item.id === exactId)
          ?? overrides.find((item) => item.id === dayId)
          ?? overrides.find((item) => item.instructorId === event.instructorId && event.dateKey >= item.startDate && event.dateKey <= item.endDate && (!item.startTime || item.startTime === event.startTime));
        return active?.action !== 'block';
      });
      for (const override of overrides.filter((item) => item.action === 'add' && !!item.startTime)) {
        for (let cursor = new Date(`${override.startDate}T00:00:00Z`); cursor <= new Date(`${override.endDate}T00:00:00Z`); cursor = addCalendarDays(cursor, 1)) {
          const day = dateKey(cursor);
          const startTime = override.startTime!;
          const [hour, minute] = startTime.split(':').map(Number);
          const endMinutes = hour * 60 + minute + 50;
          const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
          const slotId = `${override.instructorId ?? 'nyc-school'}_${day}_${startTime.replace(':', '-')}`;
          if (events.some((event) => event.slotId === slotId)) continue;
          events.push({
            id: `private_${slotId}`, productId: 'private-lesson', type: 'private_lesson', title: 'Private Lesson',
            description: 'A special 50-minute private lesson time added by the instructor.',
            start: zonedDateTime(day, startTime), end: zonedDateTime(day, endTime), timezone: SCHOOL_TIMEZONE,
            instructorId: override.instructorId ?? 'nyc-school', instructorName: 'Zhong Xin Dao NYC Instructor',
            attendanceModes: override.attendanceModes?.length ? override.attendanceModes : ['in_person', 'online'], priceCents: 12000, capacity: 1, status: 'scheduled',
            dateKey: day, startTime, endTime, slotId,
          });
        }
      }

      for (const workshop of workshops.docs) {
        const data = workshop.data() as Record<string, unknown>;
        const sessions = (data['sessions'] as Array<{ id: string; startsAt: Timestamp; endsAt: Timestamp }> | undefined) ?? [];
        const sessionIds = sessions.map((session) => session.id);
        for (const session of sessions) {
          const startAt = session.startsAt.toDate();
          if (startAt < start || startAt > end) continue;
          events.push({
            id: session.id, productId: workshop.id, type: 'workshop', title: String(data['title']),
            description: String(data['description'] ?? ''), start: startAt, end: session.endsAt.toDate(),
            timezone: 'America/New_York', instructorId: String(data['instructorId'] ?? 'nyc-school'),
            instructorName: String(data['instructorName'] ?? 'Zhong Xin Dao NYC Instructor'),
            attendanceModes: (data['attendanceModes'] as CalendarEvent['attendanceModes']) ?? ['in_person'],
            locationName: data['locationName'] ? String(data['locationName']) : undefined,
            address: data['address'] ? String(data['address']) : undefined,
            priceCents: Number(data['priceCents'] ?? 0), memberPriceCents: Number(data['memberPriceCents'] ?? 0) || undefined,
            capacity: Number(data['capacity'] ?? 0) || undefined, status: 'scheduled',
            dateKey: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(startAt),
            startTime: new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(startAt),
            endTime: new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(session.endsAt.toDate()),
            workshopSessionIds: sessionIds,
          });
        }
      }

      if (this.firebase.functions) {
        try {
          const call = httpsCallable<{ startDate: string; endDate: string }, { bookedSlotIds: string[] }>(this.firebase.functions, 'getPrivateLessonAvailability');
          const booked = new Set((await call({ startDate: dateKey(start), endDate: dateKey(end) })).data.bookedSlotIds);
          events = events.filter((event) => !event.slotId || !booked.has(event.slotId));
        } catch {
          // The default schedule remains usable while a new backend release propagates.
        }
      }
    }
    } catch {
      // Public defaults keep the calendar available during offline/local development.
    }
    this.events.set(events.sort((a, b) => a.start.getTime() - b.start.getTime()));
    this.loading.set(false);
  }

  async register(event: CalendarEvent, attendanceMode: 'online' | 'in_person'): Promise<ScheduleRegistrationResult> {
    if (!this.firebase.functions) throw new Error('Firebase Functions is not configured.');
    if (event.type === 'private_lesson') {
      const call = httpsCallable<{ dateKey: string; startTime: string; attendanceMode: string; instructorId: string }, ScheduleRegistrationResult>(this.firebase.functions, 'bookPrivateLesson');
      return (await call({ dateKey: event.dateKey, startTime: event.startTime, attendanceMode, instructorId: event.instructorId })).data;
    }
    const call = httpsCallable<{ event: Record<string, unknown>; attendanceMode: string }, ScheduleRegistrationResult>(this.firebase.functions, 'registerForScheduleEvent');
    return (await call({ event: {
      id: event.id, productId: event.productId, type: event.type, title: event.title,
      startsAt: event.start.toISOString(), endsAt: event.end.toISOString(), timezone: event.timezone,
      priceCents: event.priceCents, attendanceModes: event.attendanceModes,
      sessionIds: event.workshopSessionIds ?? [event.id],
    }, attendanceMode })).data;
  }

  async setPrivateAvailability(input: { startDate: string; endDate: string; startTime?: string; action: 'block' | 'restore' | 'add'; attendanceModes: string[] }): Promise<void> {
    const call = this.callAdmin<typeof input, { id: string }>('adminSetPrivateLessonAvailability');
    await call(input);
  }

  async saveRecurringSchedule(input: Record<string, unknown>): Promise<void> {
    const call = this.callAdmin<Record<string, unknown>, { id: string }>('adminUpsertRecurringSchedule');
    await call(input);
  }

  async cancelOccurrence(occurrenceId: string): Promise<void> {
    const call = this.callAdmin<{ occurrenceId: string }, { status: string }>('adminCancelOccurrence');
    await call({ occurrenceId });
  }

  async createWorkshop(input: Record<string, unknown>): Promise<void> {
    const call = this.callAdmin<Record<string, unknown>, { id: string }>('adminUpsertWorkshop');
    await call(input);
  }

  async loadAdminCounts(): Promise<AdminScheduleCounts> {
    const call = this.callAdmin<Record<string, never>, AdminScheduleCounts>('getAdminScheduleCounts');
    return (await call({})).data;
  }

  private callAdmin<TInput, TOutput>(name: string) {
    if (!this.firebase.functions) throw new Error('Firebase Functions is not configured.');
    return httpsCallable<TInput, TOutput>(this.firebase.functions, name);
  }
}
