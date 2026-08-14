import { Injectable } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import { Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { Functions, connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { environment } from '../../../environments/environment';
import { getFirebaseRuntimeConfig } from './firebase-runtime-config';

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly runtimeConfig = getFirebaseRuntimeConfig();
  readonly configured = this.runtimeConfig !== null;
  readonly app: FirebaseApp | null;
  readonly auth: Auth | null;
  readonly firestore: Firestore | null;
  readonly functions: Functions | null;

  constructor() {
    if (!this.configured) {
      this.app = null;
      this.auth = null;
      this.firestore = null;
      this.functions = null;
      return;
    }

    this.app = initializeApp(this.runtimeConfig!);
    this.auth = getAuth(this.app);
    this.firestore = getFirestore(this.app);
    this.functions = getFunctions(this.app, 'us-central1');

    if (environment.useEmulators && location.hostname === 'localhost') {
      connectAuthEmulator(this.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(this.firestore, '127.0.0.1', 8080);
      connectFunctionsEmulator(this.functions, '127.0.0.1', 5001);
    }
  }
}
