# Administrator access

The application authorizes administrators with a Firebase Authentication custom claim:

```json
{ "role": "admin" }
```

Firestore Security Rules and privileged Cloud Functions read this server-issued claim. A Firestore user document cannot grant administrator access.

To grant the claim, first create the email/password account in Firebase Authentication, sign in to Google Cloud CLI with a project administrator account, and run:

```bash
pnpm admins:grant -- --project iliqchuan-nyc person@example.com
```

The command preserves any other custom claims already on the account and does not store credentials or access tokens in the repository. The affected user must sign out and back in (or otherwise refresh their ID token) before the new role is active.

The three approved administrator emails are also enforced by the `syncAdminAccess` callable. A newly registered account must verify ownership of its email before the server issues the administrator claim. Google-authenticated accounts arrive with a verified email and are synchronized automatically at sign-in.
