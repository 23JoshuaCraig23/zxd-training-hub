import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { loadFirebaseRuntimeConfig } from './app/core/services/firebase-runtime-config';

loadFirebaseRuntimeConfig()
  .then(() => bootstrapApplication(App, appConfig))
  .catch((error) => console.error(error));
