import { FirebaseOptions } from 'firebase/app';

let firebaseOptions: FirebaseOptions | null = null;

export function getFirebaseRuntimeConfig(): FirebaseOptions | null {
  return firebaseOptions;
}

export async function loadFirebaseRuntimeConfig(): Promise<void> {
  // Firebase Hosting generates the first endpoint. The ignored local file is
  // only a development fallback and is never required in the repository.
  for (const url of ['/__/firebase/init.json', '/firebase-config.json']) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) continue;
      const candidate = await response.json() as FirebaseOptions;
      if (candidate.projectId && candidate.apiKey && candidate.appId) {
        firebaseOptions = candidate;
        return;
      }
    } catch {
      // Preview mode is intentional until a runtime config source is available.
    }
  }
}
