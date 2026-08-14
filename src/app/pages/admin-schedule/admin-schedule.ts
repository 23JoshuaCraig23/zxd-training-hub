import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminScheduleCounts } from '../../core/models/scheduling.models';
import { SchedulingService } from '../../core/services/scheduling.service';

@Component({
  selector: 'app-admin-schedule',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-schedule.html',
})
export class AdminSchedule implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly scheduling = inject(SchedulingService);
  protected readonly message = signal('');
  protected readonly busy = signal(false);
  protected readonly counts = signal<AdminScheduleCounts>({ registrations: 0, privateBookings: 0, onlineRegistrations: 0, inPersonRegistrations: 0 });

  protected readonly availabilityForm = this.fb.nonNullable.group({
    startDate: ['', Validators.required], endDate: [''], startTime: [''], action: ['block' as 'block' | 'restore' | 'add'],
    online: [true], inPerson: [true],
  });
  protected readonly cancellationForm = this.fb.nonNullable.group({ occurrenceId: ['', Validators.required] });
  protected readonly recurringForm = this.fb.nonNullable.group({
    id: ['daytime-weekdays', Validators.required], title: ['Daytime Online Class', Validators.required],
    description: ['Recurring group training.'], weekdays: ['1,2,3,4,5', Validators.required],
    startTime: ['12:00', Validators.required], endTime: ['13:30', Validators.required],
    type: ['online_class'], mode: ['online'], price: [28, [Validators.required, Validators.min(0)]], status: ['active'],
  });
  protected readonly workshopForm = this.fb.nonNullable.group({
    title: ['', Validators.required], description: [''], dates: ['', Validators.required],
    startTime: ['13:30', Validators.required], endTime: ['18:30', Validators.required],
    price: [185, [Validators.required, Validators.min(0)]], memberPrice: [155, [Validators.required, Validators.min(0)]],
    capacity: [36, [Validators.required, Validators.min(1)]], mode: ['in_person'], locationName: ['Manhattan training space'], address: ['Manhattan, New York, NY'],
  });

  async ngOnInit(): Promise<void> { await this.refreshCounts(); }

  protected async saveAvailability(): Promise<void> {
    if (this.availabilityForm.invalid) return;
    await this.run(async () => {
      const value = this.availabilityForm.getRawValue();
      await this.scheduling.setPrivateAvailability({
        startDate: value.startDate, endDate: value.endDate || value.startDate,
        startTime: value.startTime || undefined, action: value.action,
        attendanceModes: [value.inPerson ? 'in_person' : '', value.online ? 'online' : ''].filter(Boolean),
      });
      this.message.set('Private lesson availability updated.');
    });
  }

  protected async cancelOccurrence(): Promise<void> {
    if (this.cancellationForm.invalid) return;
    await this.run(async () => {
      await this.scheduling.cancelOccurrence(this.cancellationForm.controls.occurrenceId.value.trim());
      this.message.set('That occurrence is cancelled; its recurring series remains unchanged.');
    });
  }

  protected async saveRecurring(): Promise<void> {
    if (this.recurringForm.invalid) return;
    await this.run(async () => {
      const value = this.recurringForm.getRawValue();
      await this.scheduling.saveRecurringSchedule({
        id: value.id.trim(), title: value.title, description: value.description,
        weekdays: value.weekdays.split(',').map((day) => Number(day.trim())), startTime: value.startTime, endTime: value.endTime,
        type: value.type, attendanceModes: value.mode === 'hybrid' ? ['in_person', 'online'] : [value.mode],
        priceCents: Math.round(value.price * 100), status: value.status,
      });
      this.message.set(value.status === 'cancelled' ? 'Recurring series cancelled.' : 'Recurring schedule saved.');
    });
  }

  protected async createWorkshop(): Promise<void> {
    if (this.workshopForm.invalid) return;
    await this.run(async () => {
      const value = this.workshopForm.getRawValue();
      const dates = value.dates.split(',').map((date) => date.trim()).filter(Boolean);
      await this.scheduling.createWorkshop({
        title: value.title, description: value.description, dates, startTime: value.startTime, endTime: value.endTime,
        attendanceModes: value.mode === 'hybrid' ? ['in_person', 'online'] : [value.mode],
        priceCents: Math.round(value.price * 100), memberPriceCents: Math.round(value.memberPrice * 100),
        capacity: value.capacity, locationName: value.locationName, address: value.address,
      });
      this.message.set('Workshop published as one product with all listed sessions.');
    });
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    this.busy.set(true); this.message.set('');
    try { await operation(); await this.refreshCounts(); }
    catch (error) { this.message.set(error instanceof Error ? error.message : 'The schedule could not be updated.'); }
    finally { this.busy.set(false); }
  }

  private async refreshCounts(): Promise<void> {
    try { this.counts.set(await this.scheduling.loadAdminCounts()); } catch { /* guard already enforces access */ }
  }
}
