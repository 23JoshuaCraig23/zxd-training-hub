import { CurrencyPipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AttendanceMode, CalendarEvent, CalendarFilter, CalendarView } from '../../core/models/scheduling.models';
import { AuthService } from '../../core/services/auth.service';
import { RegistrationService } from '../../core/services/registration.service';
import { SchedulingService } from '../../core/services/scheduling.service';
import { CENTRAL_EUROPE_TIMEZONE, PACIFIC_TIMEZONE, SCHOOL_TIMEZONE, addCalendarDays, calendarDateToday, dateKey, formatInZone } from '../../core/scheduling/schedule-time';

interface DayGroup { date: Date; key: string; events: CalendarEvent[]; }

@Component({
  selector: 'app-schedule',
  imports: [CurrencyPipe, FormsModule, RouterLink],
  templateUrl: './schedule.html',
})
export class Schedule implements OnInit {
  private readonly router = inject(Router);
  private readonly registrations = inject(RegistrationService);
  protected readonly auth = inject(AuthService);
  protected readonly scheduling = inject(SchedulingService);
  protected readonly filter = signal<CalendarFilter>('all');
  protected readonly view = signal<CalendarView>(matchMedia('(max-width: 760px)').matches ? 'agenda' : 'month');
  protected readonly anchor = signal(calendarDateToday());
  protected readonly selected = signal<CalendarEvent | null>(null);
  protected readonly attendanceMode = signal<AttendanceMode>('in_person');
  protected readonly message = signal('');
  protected readonly busy = signal(false);
  protected readonly mine = signal(new Set<string>());
  protected readonly displayZone = signal(Intl.DateTimeFormat().resolvedOptions().timeZone || SCHOOL_TIMEZONE);

  protected readonly timezoneChoices = [
    { label: 'My local time', value: Intl.DateTimeFormat().resolvedOptions().timeZone || SCHOOL_TIMEZONE },
    { label: 'New York', value: SCHOOL_TIMEZONE },
    { label: 'Pacific', value: PACIFIC_TIMEZONE },
    { label: 'Central Europe', value: CENTRAL_EUROPE_TIMEZONE },
  ];

  protected readonly filtered = computed(() => this.scheduling.events().filter((event) => {
    const filter = this.filter();
    if (filter === 'all') return true;
    if (filter === 'online') return event.attendanceModes.includes('online');
    if (filter === 'in_person') return event.attendanceModes.includes('in_person');
    if (filter === 'private_lesson') return event.type === 'private_lesson';
    if (filter === 'workshop') return event.type === 'workshop';
    return this.mine().has(event.id) || this.mine().has(event.productId) || (!!event.slotId && this.mine().has(event.slotId));
  }));

  protected readonly visibleDays = computed<DayGroup[]>(() => {
    const anchor = this.anchor();
    let start: Date;
    let count: number;
    if (this.view() === 'week') {
      start = addCalendarDays(anchor, -((anchor.getUTCDay() + 6) % 7));
      count = 7;
    } else if (this.view() === 'month') {
      const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
      start = addCalendarDays(first, -((first.getUTCDay() + 6) % 7));
      count = 42;
    } else {
      start = anchor;
      count = 45;
    }
    const byDate = new Map<string, CalendarEvent[]>();
    for (const event of this.filtered()) {
      byDate.set(event.dateKey, [...(byDate.get(event.dateKey) ?? []), event]);
    }
    return Array.from({ length: count }, (_, offset) => {
      const date = addCalendarDays(start, offset);
      const key = dateKey(date);
      return { date, key, events: byDate.get(key) ?? [] };
    }).filter((day) => this.view() !== 'agenda' || day.events.length > 0);
  });

  async ngOnInit(): Promise<void> {
    await this.scheduling.loadWindow(this.anchor());
    const user = this.auth.user();
    if (user) {
      const registrations = await this.registrations.loadForStudent(user.uid).catch(() => []);
      this.mine.set(new Set(registrations.flatMap((registration) => [
        registration.offeringId,
        registration.occurrenceId ?? '',
        registration.bookingId ?? '',
        ...registration.sessionIds,
      ]).filter(Boolean)));
    }
  }

  protected setFilter(filter: CalendarFilter): void { this.filter.set(filter); }
  protected setView(view: CalendarView): void { this.view.set(view); }
  protected isOutsideMonth(day: DayGroup): boolean { return day.date.getUTCMonth() !== this.anchor().getUTCMonth(); }
  protected isToday(day: DayGroup): boolean { return day.key === dateKey(calendarDateToday()); }
  protected nonPrivateEvents(day: DayGroup): CalendarEvent[] { return day.events.filter((event) => event.type !== 'private_lesson'); }
  protected privateEvents(day: DayGroup): CalendarEvent[] { return day.events.filter((event) => event.type === 'private_lesson'); }
  protected privateDayOptions(event: CalendarEvent): CalendarEvent[] {
    return this.scheduling.events().filter((candidate) => candidate.type === 'private_lesson' && candidate.dateKey === event.dateKey);
  }

  protected async move(direction: number): Promise<void> {
    const current = this.anchor();
    const next = this.view() === 'month'
      ? new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + direction, 1))
      : addCalendarDays(current, direction * (this.view() === 'week' ? 7 : 30));
    this.anchor.set(next);
    await this.scheduling.loadWindow(next);
  }

  protected async today(): Promise<void> {
    this.anchor.set(calendarDateToday());
    await this.scheduling.loadWindow(this.anchor());
  }

  protected open(event: CalendarEvent): void {
    this.selected.set(event);
    this.attendanceMode.set(event.attendanceModes[0]);
    this.message.set('');
  }

  protected close(): void { this.selected.set(null); this.message.set(''); }

  protected async register(): Promise<void> {
    const event = this.selected();
    if (!event) return;
    if (!this.auth.user()) {
      await this.router.navigate(['/auth'], { queryParams: { returnUrl: '/schedule' } });
      return;
    }
    this.busy.set(true);
    this.message.set('');
    try {
      const result = await this.scheduling.register(event, this.attendanceMode());
      this.mine.update((items) => new Set([...items, event.id, event.productId, event.slotId ?? '']));
      this.message.set(result.bookingId
        ? 'This private lesson is reserved. Continue to payment from your student dashboard.'
        : 'Registration started. Continue to payment from your student dashboard.');
      await this.scheduling.loadWindow(this.anchor());
    } catch (error) {
      const code = (error as { code?: string }).code;
      this.message.set(code?.includes('already-exists')
        ? 'That private lesson was just booked by someone else. Please choose another time.'
        : error instanceof Error ? error.message : 'We could not complete the booking. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }

  protected eventLabel(event: CalendarEvent): string {
    return event.type === 'online_class' ? 'Online' : event.type === 'hybrid_class' ? 'Manhattan + Online' : event.type === 'private_lesson' ? 'Private' : 'Workshop';
  }

  protected formatDay(date: Date, compact = false): string {
    return formatInZone(date, 'UTC', compact ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric' });
  }

  protected formatMonth(date: Date): string { return formatInZone(date, 'UTC', { month: 'long', year: 'numeric' }); }
  protected formatTime(date: Date): string { return formatInZone(date, this.displayZone(), { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
  protected formatRange(event: CalendarEvent): string { return `${this.formatTime(event.start)}–${this.formatTime(event.end)}`; }
}
