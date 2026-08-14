import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-auth',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './auth.html',
})
export class Auth {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly auth = inject(AuthService);
  protected readonly mode = signal<'signin' | 'register'>('signin');
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly isRegistering = computed(() => this.mode() === 'register');

  protected readonly form = this.fb.nonNullable.group({
    name: [''],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  protected setMode(mode: 'signin' | 'register'): void {
    this.mode.set(mode);
    this.message.set('');
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.message.set('');
    const { name, email, password } = this.form.getRawValue();
    try {
      if (this.isRegistering()) await this.auth.register(name.trim(), email.trim(), password);
      else await this.auth.signIn(email.trim(), password);
      await this.router.navigateByUrl(this.route.snapshot.queryParamMap.get('returnUrl') || '/dashboard');
    } catch (error) {
      this.message.set(this.friendlyError(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async resetPassword(): Promise<void> {
    const email = this.form.controls.email.value.trim();
    if (!email || this.form.controls.email.invalid) {
      this.message.set('Enter your email address first, then choose reset password.');
      return;
    }
    try {
      await this.auth.resetPassword(email);
      this.message.set('Password reset email sent. Check your inbox.');
    } catch (error) {
      this.message.set(this.friendlyError(error));
    }
  }

  private friendlyError(error: unknown): string {
    const code = (error as { code?: string }).code;
    if (code === 'auth/invalid-credential') return 'That email and password do not match.';
    if (code === 'auth/email-already-in-use') return 'An account already exists for that email.';
    if (code === 'auth/weak-password') return 'Choose a stronger password with at least 8 characters.';
    return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  }
}
