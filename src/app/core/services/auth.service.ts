import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  Auth,
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { FirebaseService } from './firebase.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly firebase = inject(FirebaseService);
  private readonly router = inject(Router);
  private resolveReady!: () => void;
  private didResolveReady = false;

  readonly user = signal<User | null>(null);
  readonly ready = signal(false);
  readonly whenReady = new Promise<void>((resolve) => (this.resolveReady = resolve));
  readonly configured = this.firebase.configured;

  constructor() {
    if (!this.firebase.auth) {
      this.finishInitialization(null);
      return;
    }

    onAuthStateChanged(this.firebase.auth, (user) => this.finishInitialization(user));
  }

  async signIn(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.requireAuth(), email, password);
  }

  async signInWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(this.requireAuth(), provider);
    await this.ensureStudentProfile(credential.user);
  }

  async register(name: string, email: string, password: string): Promise<void> {
    const credential = await createUserWithEmailAndPassword(this.requireAuth(), email, password);
    await updateProfile(credential.user, { displayName: name });

    await this.ensureStudentProfile(credential.user, name);
  }

  async resetPassword(email: string): Promise<void> {
    await sendPasswordResetEmail(this.requireAuth(), email);
  }

  async signOut(): Promise<void> {
    if (this.firebase.auth) await firebaseSignOut(this.firebase.auth);
    await this.router.navigateByUrl('/');
  }

  private requireAuth(): Auth {
    if (!this.firebase.auth) {
      throw new Error('Firebase is not configured yet. Add your web app values to environment.ts.');
    }
    return this.firebase.auth;
  }

  private async ensureStudentProfile(user: User, displayName = user.displayName || ''): Promise<void> {
    if (!this.firebase.firestore || !user.email) return;
    const profile = doc(this.firebase.firestore, 'users', user.uid);
    if ((await getDoc(profile)).exists()) return;

    await setDoc(profile, {
      displayName,
      email: user.email,
      role: 'student',
      createdAt: serverTimestamp(),
    });
  }

  private finishInitialization(user: User | null): void {
    this.user.set(user);
    this.ready.set(true);
    if (!this.didResolveReady) {
      this.didResolveReady = true;
      this.resolveReady();
    }
  }
}
