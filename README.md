# Zhong Xin Dao Training Hub

An Angular 22 + Firebase application for live Zhong Xin Dao I Liq Chuan training. It includes a timezone-safe class calendar, recurring and hybrid classes, concurrency-safe private lesson booking, multi-day workshops, Firebase email/Google authentication, a protected student dashboard, claim-protected scheduling administration, PayPal-verified registrations, and private Zoom access.

## What is implemented

- Responsive Angular catalog for group classes, workshops, and private lessons.
- Firebase Authentication with email/password registration, sign-in, sign-out, and password reset.
- Firestore-backed offerings and student registrations, with realistic preview data before Firebase is connected.
- Protected dashboard that obtains Zoom access through a callable Cloud Function rather than reading meeting URLs from Firestore.
- Server-side PayPal order creation and webhook verification. A browser return from PayPal never confirms payment.
- Idempotent Zoom meeting creation: one deterministic meeting record per session, shared by all confirmed students.
- Subscription/entitlement registration path kept separate from one-time payment.
- Firestore rules, indexes, local Emulator Suite configuration, and Google Cloud Build deployment.

See [docs/architecture.md](docs/architecture.md) for the data model and protected workflow.

## Cloud deployment prerequisites

- A Firebase project on the Blaze plan (Cloud Functions makes outbound Zoom/PayPal requests)
- A GitHub repository connected to Google Cloud Build
- A Zoom Server-to-Server OAuth app
- A PayPal developer application and webhook

The default workflow does not require Node, npm, pnpm, Firebase CLI, or Java on a local computer. Google Cloud Build provides the complete build environment. See [docs/cloud-build.md](docs/cloud-build.md).

## 1. Connect Firebase

1. Create a Firebase project and add a Web app in the Firebase console.
2. Enable **Authentication → Sign-in method → Email/Password**.
3. Create a Firestore database.
4. Associate this directory with the Firebase project:

```bash
pnpm install
pnpm firebase login
pnpm firebase use --add
```

Do not commit `.firebaserc` if the project ID is private; it is ignored. `.firebaserc.example` documents the shape.

The Angular app first checks Firebase Hosting's browser-safe configuration at `/__/firebase/init.json`, then falls back to the registered Web App configuration in `public/firebase-config.json`. The fallback is committed because Firebase Web App configuration is public metadata delivered to every browser; it contains no server credentials.

Firebase's browser `apiKey` identifies a project but is not a server credential and is visible to every browser after deployment. Protect Firebase data with the included Security Rules, authorized domains, API-key restrictions, and App Check—not by treating that browser key as a password.

The scheduling architecture and collection responsibilities are documented in [`docs/scheduling.md`](docs/scheduling.md).

## 2. Configure server secrets

Create a Zoom Server-to-Server OAuth app with meeting read/write scopes and a PayPal developer application.

### Using the UI

1. From Firebase Project Settings, open the linked Google Cloud project.
2. In Google Cloud Console, open **Security → Secret Manager** (enable the API if prompted).
3. Create these secrets using the exact names shown. The first five match the existing Google Cloud setup:

| Secret name        | Value                                        |
| ------------------ | -------------------------------------------- |
| `PayPalClientID`   | PayPal REST application client ID            |
| `PayPalSecret`     | PayPal REST application secret               |
| `ZoomAccountID`    | Zoom Server-to-Server OAuth account ID       |
| `ZoomClientID`     | Zoom Server-to-Server OAuth client ID        |
| `ZoomClientSecret` | Zoom Server-to-Server OAuth client secret    |
| `PayPalWebhookID`  | PayPal webhook ID for signature verification |

4. Add the missing `PayPalWebhookID` secret after creating the webhook in the PayPal developer dashboard. This ID is required to verify that registration events really came from PayPal.
5. Run `pnpm firebase deploy --only functions`. Deployment binds each secret only to the Functions that declare it. Redeploy Functions after creating a new secret version.

PayPal uses Sandbox by default through the committed, non-secret `functions/.env.iliqchuan-nyc` parameter file. Change `PAYPAL_API_BASE` there to `https://api-m.paypal.com` only when production credentials and production webhook validation are ready. Never add credentials to an environment file; they belong in Secret Manager.

### Using the CLI

The Firebase CLI is the recommended shortcut because it creates a secret version and prompts without echoing the value into a command:

```bash
pnpm firebase functions:secrets:set PayPalClientID
pnpm firebase functions:secrets:set PayPalSecret
pnpm firebase functions:secrets:set PayPalWebhookID
pnpm firebase functions:secrets:set ZoomAccountID
pnpm firebase functions:secrets:set ZoomClientID
pnpm firebase functions:secrets:set ZoomClientSecret
pnpm firebase deploy --only functions
```

All Zoom and PayPal credentials are declared with Firebase `defineSecret`. They are read only inside explicitly bound Cloud Functions at runtime and are never bundled into Angular, stored in Firestore, or committed to GitHub.

After deploying `handlePayPalWebhook`, register its HTTPS URL in the PayPal dashboard for `PAYMENT.CAPTURE.COMPLETED` events.

## 3. Build and deploy in Google Cloud

Connect the GitHub repository to **Cloud Build → Repositories**, then create a `main` branch trigger using `/cloudbuild.yaml` and the dedicated deployment service account described in [docs/cloud-build.md](docs/cloud-build.md).

Every push to `main` will:

1. Install locked dependencies in Node.js 22.
2. Run Angular tests.
3. Build Angular and Firebase Functions.
4. Deploy Firestore, Functions, and Hosting to the trigger's Google Cloud project.

## 4. Optional local development

For the visual app with preview data:

```bash
pnpm start
```

For Firebase-backed local development, set `useEmulators: true`, then run in separate terminals:

```bash
pnpm build:all
pnpm emulators
pnpm start
```

Local prerequisites are Node.js 22+, pnpm 11+, and Java 21+ for the Firebase emulators. Local installation is optional.

## 5. Manual local validation and deployment

```bash
pnpm test -- --run
pnpm build:all
pnpm deploy
```

The Angular SPA deploys to Firebase Hosting, and `firebase.json` rewrites application routes to `index.html`.

## 6. Publish the repository to GitHub

The repository is already initialized locally on the `main` branch. Create an empty GitHub repository, then connect and push it:

```bash
git remote add origin git@github.com:YOUR_ORG/zxd-training-hub.git
git push -u origin main
```

No Firebase, Zoom, or PayPal secrets belong in GitHub. Google Cloud Build handles tests, builds, and Firebase deployment after each push to `main`.

## Next product slices

1. Admin CRUD screens for offerings, sessions, instructors, and availability.
2. Session-picker and PayPal checkout UI wired to `createPendingRegistration` and `createPayPalOrder`.
3. Private lesson availability locking and booking confirmation email.
4. Workshop full-pass versus per-session purchase UI.
5. Subscription lifecycle webhooks and administrator-defined cancellation/access rules.
