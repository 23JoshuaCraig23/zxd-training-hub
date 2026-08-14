# Zhong Xin Dao Training Hub

An Angular 22 + Firebase starter for live Zhong Xin Dao I Liq Chuan training. It includes a public training catalog, Firebase email/password authentication, a protected student dashboard, Firestore security rules, Firebase Hosting configuration, and Cloud Functions foundations for PayPal-verified registrations and Zoom access.

## What is implemented

- Responsive Angular catalog for group classes, workshops, and private lessons.
- Firebase Authentication with email/password registration, sign-in, sign-out, and password reset.
- Firestore-backed offerings and student registrations, with realistic preview data before Firebase is connected.
- Protected dashboard that obtains Zoom access through a callable Cloud Function rather than reading meeting URLs from Firestore.
- Server-side PayPal order creation and webhook verification. A browser return from PayPal never confirms payment.
- Idempotent Zoom meeting creation: one deterministic meeting record per session, shared by all confirmed students.
- Subscription/entitlement registration path kept separate from one-time payment.
- Firestore rules, indexes, local Emulator Suite configuration, and GitHub Actions build checks.

See [docs/architecture.md](docs/architecture.md) for the data model and protected workflow.

## Prerequisites

- Node.js 24+
- pnpm 11+
- A Firebase project on the Blaze plan (Cloud Functions makes outbound Zoom/PayPal requests)
- A Zoom Server-to-Server OAuth app
- A PayPal developer application and webhook

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

Firebase Hosting automatically serves the browser-safe app configuration at `/__/firebase/init.json`; the Angular app loads it before startup. No Firebase configuration is compiled into the repository. For `ng serve`, create an ignored `public/firebase-config.json` containing the Firebase Web App configuration from Project Settings. The filename is already in `.gitignore`.

Firebase's browser `apiKey` identifies a project but is not a server credential and is visible to every browser after deployment. Protect Firebase data with the included Security Rules, authorized domains, API-key restrictions, and App Check—not by treating that browser key as a password.

## 2. Configure server secrets

Create a Zoom Server-to-Server OAuth app with meeting read/write scopes and a PayPal developer application.

### Using the UI

1. From Firebase Project Settings, open the linked Google Cloud project.
2. In Google Cloud Console, open **Security → Secret Manager** (enable the API if prompted).
3. Choose **Create secret**, name it `ZOOM_CONFIG`, and enter this JSON with real values:

```json
{"accountId":"...","clientId":"...","clientSecret":"..."}
```

4. Create `PAYPAL_CONFIG` with Sandbox values:

```json
{"clientId":"...","clientSecret":"...","webhookId":"...","apiBase":"https://api-m.sandbox.paypal.com"}
```

5. Run `pnpm firebase deploy --only functions`. Deployment binds each secret only to the Functions that declare it. Redeploy Functions after creating a new secret version.

For production PayPal, change `apiBase` to `https://api-m.paypal.com` and use production credentials and the production webhook ID.

### Using the CLI

The Firebase CLI is the recommended shortcut because it creates a secret version and prompts without echoing the value into a command:

```bash
pnpm firebase functions:secrets:set ZOOM_CONFIG --format=json
pnpm firebase functions:secrets:set PAYPAL_CONFIG --format=json
pnpm firebase deploy --only functions
```

All Zoom and PayPal credentials are declared with Firebase `defineJsonSecret`. They are read only inside explicitly bound Cloud Functions at runtime and are never bundled into Angular, stored in Firestore, or committed to GitHub.

After deploying `handlePayPalWebhook`, register its HTTPS URL in the PayPal dashboard for `PAYMENT.CAPTURE.COMPLETED` events.

## 3. Run locally

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

## 4. Validate and deploy

```bash
pnpm test -- --run
pnpm build:all
pnpm deploy
```

The Angular SPA deploys to Firebase Hosting, and `firebase.json` rewrites application routes to `index.html`.

## 5. Publish the repository to GitHub

The repository is already initialized locally on the `main` branch. Create an empty GitHub repository, then connect and push it:

```bash
git remote add origin git@github.com:YOUR_ORG/zxd-training-hub.git
git push -u origin main
```

No Firebase, Zoom, or PayPal secrets belong in GitHub. The included workflow runs both frontend and Functions builds on pushes and pull requests.

## Next product slices

1. Admin CRUD screens for offerings, sessions, instructors, and availability.
2. Session-picker and PayPal checkout UI wired to `createPendingRegistration` and `createPayPalOrder`.
3. Private lesson availability locking and booking confirmation email.
4. Workshop full-pass versus per-session purchase UI.
5. Subscription lifecycle webhooks and administrator-defined cancellation/access rules.
