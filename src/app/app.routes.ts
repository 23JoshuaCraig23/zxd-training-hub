import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home').then((m) => m.Home),
    title: 'Online Training | Zhong Xin Dao',
  },
  { path: 'training', redirectTo: '', pathMatch: 'full' },
  {
    path: 'schedule',
    loadComponent: () => import('./pages/schedule/schedule').then((m) => m.Schedule),
    title: 'Class schedule | Zhong Xin Dao',
  },
  {
    path: 'auth',
    loadComponent: () => import('./pages/auth/auth').then((m) => m.Auth),
    title: 'Student sign in | Zhong Xin Dao',
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.Dashboard),
    title: 'My training | Zhong Xin Dao',
  },
  {
    path: 'admin/schedule',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/admin-schedule/admin-schedule').then((m) => m.AdminSchedule),
    title: 'Schedule administration | Zhong Xin Dao',
  },
  { path: '**', redirectTo: '' },
];
