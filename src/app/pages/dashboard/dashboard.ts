import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionAccess, StudentRegistration } from '../../core/models/training.models';
import { AuthService } from '../../core/services/auth.service';
import { RegistrationService } from '../../core/services/registration.service';

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, RouterLink],
  templateUrl: './dashboard.html',
})
export class Dashboard implements OnInit {
  private readonly registrationsService = inject(RegistrationService);
  protected readonly auth = inject(AuthService);
  protected readonly registrations = signal<StudentRegistration[]>([]);
  protected readonly access = signal<Record<string, SessionAccess>>({});
  protected readonly loading = signal(true);
  protected readonly message = signal('');

  async ngOnInit(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      this.registrations.set(await this.registrationsService.loadForStudent(user.uid));
    } catch {
      this.message.set('We could not load your registrations. Please refresh and try again.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async revealAccess(sessionId: string): Promise<void> {
    this.message.set('');
    try {
      const result = await this.registrationsService.getSessionAccess(sessionId);
      this.access.update((current) => ({ ...current, [sessionId]: result }));
    } catch {
      this.message.set('Meeting access becomes available after your registration is confirmed.');
    }
  }
}
