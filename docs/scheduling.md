# Scheduling and booking

All school-created schedules use the IANA timezone `America/New_York`. The client converts instants with `Intl.DateTimeFormat`, preserving the New York wall time across US and European daylight-saving transitions.

## Collections

- `recurringSchedules`: reusable schedule definitions; weekly defaults are generated only for a bounded display window.
- `eventOccurrences`: cancellations, capacity counters, and modifications for individual recurring dates.
- `workshops`: one registration product containing one or more timestamped sessions.
- `privateLessonAvailability`: administrator block/restore overrides for a time, day, or date range.
- `privateLessonBookings`: one server-owned document per instructor/date/start-time slot.
- `registrations`: one document per student registration; never an array embedded in an event.
- `sessions`: private server/Zoom integration metadata for each scheduled session.

## Private lesson concurrency

The callable `bookPrivateLesson` derives a deterministic slot ID such as `nyc-school_2026-09-14_10-00`. A Firestore transaction reads that document and creates the booking, registration, and session atomically. A second concurrent transaction cannot reserve the same slot. Pending-payment holds expire after 15 minutes and may then be replaced.

## Payment and access

Schedule registration creates a `pending_payment` registration compatible with the existing PayPal order/webhook flow. Payment confirmation activates the registration. Online attendance then creates a private Zoom meeting and access grant; in-person attendance never receives a Zoom link.

## Administrator controls

The `/admin/schedule` route requires the Firebase Auth custom claim `role: admin`. The same claim is verified again by every administrator callable and by Firestore Rules. The UI supports individual occurrence cancellation, private lesson date/time/range overrides, multi-day workshop publishing, and online/in-person registration totals.
