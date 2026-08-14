# Architecture

## Boundaries

The application intentionally keeps business concepts separate:

- `offerings`: the sellable class, private lesson type, subscription, or workshop.
- `sessions`: one scheduled occurrence. It contains public schedule data but no Zoom URL.
- `registrations`: a student's request/authorization for one or more sessions.
- `payments`: verified provider transactions, written only by Cloud Functions.
- `entitlements`: active subscription rights that can confirm a registration without another payment.
- `videoMeetings`: provider-specific meeting metadata. These documents are never client-readable.
- `accessGrants`: the student-to-session authorization created after payment or entitlement verification.

This makes it possible to add another video provider without changing offering, registration, or payment documents.

## Paid registration sequence

```text
Angular creates pending registration
  → callable Function creates PayPal order
  → student completes PayPal checkout
  → PayPal sends signed webhook
  → Function verifies webhook with PayPal
  → payment becomes PAID
  → registration becomes CONFIRMED
  → Function claims deterministic videoMeetings/zoom_{sessionId}
  → Zoom meeting is created only if no ready meeting exists
  → accessGrant is written for the student and session
  → dashboard calls getSessionAccess
  → Function checks the grant and returns the protected join URL
```

The user's browser return from checkout is never evidence of payment.

## Secrets and public configuration

- Zoom and PayPal credentials live in the `ZOOM_CONFIG` and `PAYPAL_CONFIG` JSON secrets in Firebase Secret Manager and are injected only into the Functions that declare them.
- Firebase Hosting supplies the browser configuration dynamically at `/__/firebase/init.json`; no project configuration is committed.
- A Firebase Web API key is necessarily public in a browser app. Firestore Rules, authorized domains, API restrictions, and App Check enforce access.
- Meeting URLs and payment provider records are server-only Firestore documents.

## Authorization

- Anonymous users can read published offerings and scheduled/completed public session metadata.
- Students can read only their own profile, registrations, entitlements, and access grants.
- No browser can read `videoMeetings`, `payments`, or webhook receipts directly.
- `getSessionAccess` returns a student join URL only when an active grant exists.
- Instructors assigned to a session and users with an `admin` custom claim can receive host access.
- Administrative writes should run through privileged Functions or an admin UI backed by Functions.

## Meeting idempotency

`videoMeetings/zoom_{sessionId}` is a deterministic document. A short Firestore lease lets one Function invocation create the Zoom meeting. Parallel registrations reuse a ready record or retry while creation is in progress. A private lesson still gets its own meeting because each booked appointment has its own session ID.

## Suggested document shapes

```text
offerings/{offeringId}
  title, type, deliveryMode, status, priceCents, currency, nextStartAt

sessions/{sessionId}
  offeringId, title, startsAt, durationMinutes, timezone, instructorId, status

registrations/{registrationId}
  studentId, offeringId, sessionIds[], status, paymentStatus, paymentMode

videoMeetings/zoom_{sessionId}
  provider, providerMeetingId, sessionId, status, joinUrl, startUrl, passcode

accessGrants/{studentId}_{sessionId}
  studentId, sessionId, registrationId, status
```
