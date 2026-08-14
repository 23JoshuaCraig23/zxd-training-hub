import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.whenReady;
  if (!auth.user()) return router.createUrlTree(['/auth'], { queryParams: { returnUrl: '/admin/schedule' } });
  return auth.isAdmin() ? true : router.createUrlTree(['/schedule']);
};
