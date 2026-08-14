import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { defineSecret, defineString } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { randomUUID } from 'node:crypto';

initializeApp();
const db = getFirestore();
const region = 'us-central1';

const payPalClientId = defineSecret('PayPalClientID');
const payPalSecret = defineSecret('PayPalSecret');
const payPalWebhookId = defineSecret('PayPalWebhookID');
const zoomAccountId = defineSecret('ZoomAccountID');
const zoomClientId = defineSecret('ZoomClientID');
const zoomClientSecret = defineSecret('ZoomClientSecret');
const payPalApiBase = defineString('PAYPAL_API_BASE', {
  default: 'https://api-m.sandbox.paypal.com',
});

type Json = Record<string, unknown>;
type AttendanceMode = 'online' | 'in_person';
const schoolTimezone = 'America/New_York';
const privateLessonStarts = new Set(['08:00', '09:00', '10:00', '11:00', '15:00', '16:00', '17:00']);
const administratorEmails = new Set([
  'info@iliqchuan.nyc',
  'joshua.craig@iliqchuan.com',
  'joshua@joshuacraig.org',
]);

export const syncAdminAccess = onCall({ region }, async (request) => {
  const uid = requireUser(request.auth?.uid);
  const email = String(request.auth?.token['email'] ?? '').toLowerCase();
  if (!administratorEmails.has(email)) return { isAdmin: false };
  if (request.auth?.token['email_verified'] !== true) {
    throw new HttpsError('failed-precondition', 'Verify this email address before administrator access can be granted.');
  }
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...user.customClaims, role: 'admin' });
  return { isAdmin: true };
});

export const getPrivateLessonAvailability = onCall({ region }, async (request) => {
  const data = request.data as { startDate?: string; endDate?: string };
  const startDate = requireDateKey(data.startDate, 'startDate');
  const endDate = requireDateKey(data.endDate, 'endDate');
  if (startDate > endDate) throw new HttpsError('invalid-argument', 'The date range is invalid.');
  const snapshot = await db.collection('privateLessonBookings')
    .where('dateKey', '>=', startDate).where('dateKey', '<=', endDate).limit(500).get();
  const now = Date.now();
  return {
    bookedSlotIds: snapshot.docs.filter((item) => {
      if (item.get('status') === 'confirmed') return true;
      const hold = item.get('holdExpiresAt') as Timestamp | undefined;
      return item.get('status') === 'pending_payment' && !!hold && hold.toMillis() > now;
    }).map((item) => item.id),
  };
});

export const bookPrivateLesson = onCall({ region }, async (request) => {
  const uid = requireUser(request.auth?.uid);
  const data = request.data as { dateKey?: string; startTime?: string; attendanceMode?: string; instructorId?: string };
  const bookingDate = requireDateKey(data.dateKey, 'dateKey');
  const startTime = requireString(data.startTime, 'startTime');
  const instructorId = requireString(data.instructorId, 'instructorId');
  const attendanceMode = requireAttendanceMode(data.attendanceMode);
  const wallDate = new Date(`${bookingDate}T12:00:00Z`);
  const startsAt = zonedWallTime(bookingDate, startTime, schoolTimezone);
  if (startsAt.toMillis() < Date.now() + 15 * 60 * 1000) throw new HttpsError('failed-precondition', 'This lesson time is no longer bookable.');

  const slotId = `${instructorId}_${bookingDate}_${startTime.replace(':', '-')}`;
  const [slotOverride, dayOverride, rangeOverrides] = await Promise.all([
    db.collection('privateLessonAvailability').doc(slotId).get(),
    db.collection('privateLessonAvailability').doc(`${instructorId}_${bookingDate}`).get(),
    db.collection('privateLessonAvailability').where('instructorId', '==', instructorId).where('startDate', '<=', bookingDate).get(),
  ]);
  const matchingRange = rangeOverrides.docs.find((item) => item.get('endDate') >= bookingDate && (!item.get('startTime') || item.get('startTime') === startTime));
  const activeOverride = slotOverride.exists ? slotOverride : dayOverride.exists ? dayOverride : matchingRange;
  if ((wallDate.getUTCDay() < 1 || wallDate.getUTCDay() > 5) && activeOverride?.get('action') !== 'add') throw new HttpsError('failed-precondition', 'Private lessons are offered Monday through Friday.');
  if (!privateLessonStarts.has(startTime) && activeOverride?.get('action') !== 'add') throw new HttpsError('invalid-argument', 'This private lesson time was not added by an administrator.');
  if (activeOverride?.get('action') === 'block') throw new HttpsError('failed-precondition', 'This lesson time is blocked.');
  const modes = activeOverride?.get('attendanceModes') as AttendanceMode[] | undefined;
  if (modes && !modes.includes(attendanceMode)) throw new HttpsError('failed-precondition', 'That attendance method is unavailable for this lesson.');

  const bookingRef = db.collection('privateLessonBookings').doc(slotId);
  const registrationRef = db.collection('registrations').doc();
  const sessionRef = db.collection('sessions').doc(`private_${slotId}`);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(bookingRef);
    if (existing.exists) {
      const hold = existing.get('holdExpiresAt') as Timestamp | undefined;
      const expired = existing.get('status') === 'pending_payment' && hold && hold.toMillis() <= Date.now();
      if (!expired) throw new HttpsError('already-exists', 'This private lesson was just booked.');
    }
    const holdExpiresAt = Timestamp.fromMillis(Date.now() + 15 * 60 * 1000);
    transaction.set(bookingRef, {
      slotId, instructorId, studentId: uid, dateKey: bookingDate, startTime,
      startsAt, endsAt: Timestamp.fromMillis(startsAt.toMillis() + 50 * 60 * 1000),
      timezone: schoolTimezone, attendanceMode, status: 'pending_payment', holdExpiresAt,
      registrationId: registrationRef.id, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(sessionRef, {
      title: 'Private Lesson', instructorId, startsAt,
      durationMinutes: 50, timezone: schoolTimezone, attendanceModes: [attendanceMode], status: 'scheduled',
    }, { merge: true });
    transaction.set(registrationRef, {
      offeringId: 'private-lesson', offeringTitle: 'Private Lesson', occurrenceId: sessionRef.id,
      bookingId: slotId, studentId: uid, sessionIds: [sessionRef.id], attendanceMode,
      locationName: attendanceMode === 'in_person' ? 'Manhattan training space' : null,
      address: attendanceMode === 'in_person' ? 'Manhattan, New York, NY' : null,
      amountCents: 12000, currency: 'USD', status: 'pending_payment', paymentStatus: 'pending',
      paymentMode: 'paypal', nextSessionAt: startsAt, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { bookingId: slotId, registrationId: registrationRef.id, status: 'pending_payment' };
});

export const registerForScheduleEvent = onCall({ region }, async (request) => {
  const uid = requireUser(request.auth?.uid);
  const data = request.data as { event?: Json; attendanceMode?: string };
  const event = data.event ?? {};
  const occurrenceId = requireSafeId(event['id'], 'event ID');
  const productId = requireSafeId(event['productId'], 'product ID');
  const attendanceMode = requireAttendanceMode(data.attendanceMode);
  const attendanceModes = requireAttendanceModes(event['attendanceModes']);
  if (!attendanceModes.includes(attendanceMode)) throw new HttpsError('invalid-argument', 'That attendance method is unavailable.');
  const startsAt = requireFutureTimestamp(event['startsAt'], 'startsAt');
  const endsAt = requireFutureTimestamp(event['endsAt'], 'endsAt');
  if (endsAt.toMillis() <= startsAt.toMillis()) throw new HttpsError('invalid-argument', 'The event time is invalid.');
  const product = await resolveScheduleProduct(productId);
  if (!product.attendanceModes.includes(attendanceMode)) throw new HttpsError('invalid-argument', 'That attendance method is unavailable.');
  const sessionIds = requireStringArray(event['sessionIds'], 'sessionIds');
  const registrationKey = product.type === 'workshop' ? productId : occurrenceId;
  const registrationRef = db.collection('registrations').doc(`${uid}_${registrationKey}`);
  const occurrenceRef = db.collection('eventOccurrences').doc(occurrenceId);
  const counterRef = product.type === 'workshop' ? db.collection('eventOccurrences').doc(`product_${productId}`) : occurrenceRef;
  const sessionRef = db.collection('sessions').doc(occurrenceId);

  await db.runTransaction(async (transaction) => {
    const occurrence = await transaction.get(occurrenceRef);
    const counter = counterRef.path === occurrenceRef.path ? occurrence : await transaction.get(counterRef);
    const existingRegistration = await transaction.get(registrationRef);
    if (existingRegistration.exists && existingRegistration.get('status') !== 'cancelled') {
      throw new HttpsError('already-exists', 'You already have a registration for this event.');
    }
    if (occurrence.get('status') === 'cancelled') throw new HttpsError('failed-precondition', 'This class was cancelled.');
    const total = Number(counter.get('registrationCount') ?? 0);
    const inPerson = Number(counter.get('inPersonRegistrationCount') ?? 0);
    const capacity = attendanceMode === 'in_person' ? product.inPersonCapacity ?? product.capacity : product.capacity;
    if (capacity && (attendanceMode === 'in_person' ? inPerson : total) >= capacity) throw new HttpsError('resource-exhausted', 'This event is full.');
    transaction.set(counterRef, {
      productId, type: product.type, title: product.title, startsAt, endsAt,
      dateKey: new Intl.DateTimeFormat('en-CA', { timeZone: schoolTimezone }).format(startsAt.toDate()),
      timezone: schoolTimezone, status: 'scheduled', registrationCount: total + 1,
      inPersonRegistrationCount: inPerson + (attendanceMode === 'in_person' ? 1 : 0),
      onlineRegistrationCount: Number(counter.get('onlineRegistrationCount') ?? 0) + (attendanceMode === 'online' ? 1 : 0),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (counterRef.path !== occurrenceRef.path) {
      transaction.set(occurrenceRef, { productId, type: product.type, title: product.title, startsAt, endsAt, dateKey: new Intl.DateTimeFormat('en-CA', { timeZone: schoolTimezone }).format(startsAt.toDate()), timezone: schoolTimezone, status: 'scheduled', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    const productSessions = product.sessions?.length ? product.sessions : [{ id: sessionRef.id, startsAt, endsAt }];
    for (const session of productSessions) {
      transaction.set(db.collection('sessions').doc(session.id), {
        title: product.title, startsAt: session.startsAt,
        durationMinutes: Math.round((session.endsAt.toMillis() - session.startsAt.toMillis()) / 60000),
        timezone: schoolTimezone, attendanceModes: product.attendanceModes, status: 'scheduled',
      }, { merge: true });
    }
    transaction.set(registrationRef, {
      offeringId: productId, offeringTitle: product.title, occurrenceId, studentId: uid,
      sessionIds, attendanceMode, amountCents: product.priceCents, currency: 'USD',
      locationName: attendanceMode === 'in_person' ? product.locationName ?? null : null,
      address: attendanceMode === 'in_person' ? product.address ?? null : null,
      status: 'pending_payment', paymentStatus: 'pending', paymentMode: 'paypal', nextSessionAt: startsAt,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { registrationId: registrationRef.id, status: 'pending_payment' };
});

export const adminSetPrivateLessonAvailability = onCall({ region }, async (request) => {
  requireAdmin(request.auth?.token['role']);
  const data = request.data as { startDate?: string; endDate?: string; startTime?: string; action?: string; attendanceModes?: unknown; instructorId?: string };
  const startDate = requireDateKey(data.startDate, 'startDate');
  const endDate = requireDateKey(data.endDate ?? data.startDate, 'endDate');
  if (startDate > endDate) throw new HttpsError('invalid-argument', 'The date range is invalid.');
  const instructorId = requireSafeId(data.instructorId ?? 'nyc-school', 'instructorId');
  const action = data.action === 'restore' ? 'restore' : data.action === 'add' ? 'add' : 'block';
  const startTime = data.startTime ? requireString(data.startTime, 'startTime') : undefined;
  if (action === 'add' && !startTime) throw new HttpsError('invalid-argument', 'An added lesson needs a starting time.');
  const modes = data.attendanceModes ? requireAttendanceModes(data.attendanceModes) : ['in_person', 'online'];
  const id = `${instructorId}_${startDate}${endDate !== startDate ? `_${endDate}` : ''}${startTime ? `_${startTime.replace(':', '-')}` : ''}`;
  await db.collection('privateLessonAvailability').doc(id).set({
    instructorId, startDate, endDate, startTime: startTime ?? null, action, attendanceModes: modes,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id, status: action };
});

export const adminUpsertRecurringSchedule = onCall({ region }, async (request) => {
  requireAdmin(request.auth?.token['role']);
  const data = request.data as { id?: string; title?: string; description?: string; weekdays?: number[]; startTime?: string; endTime?: string; type?: string; attendanceModes?: unknown; priceCents?: number; status?: string };
  const id = requireSafeId(data.id, 'id');
  const weekdays = [...new Set((data.weekdays ?? []).map(Number))];
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new HttpsError('invalid-argument', 'weekdays is invalid.');
  const type = data.type;
  if (type !== 'online_class' && type !== 'hybrid_class') throw new HttpsError('invalid-argument', 'Recurring class type is invalid.');
  const startTime = requireString(data.startTime, 'startTime');
  const endTime = requireString(data.endTime, 'endTime');
  await db.collection('recurringSchedules').doc(id).set({
    title: requireString(data.title, 'title'), description: String(data.description ?? ''), weekdays,
    startTime, endTime, timezone: schoolTimezone, type, attendanceModes: requireAttendanceModes(data.attendanceModes),
    priceCents: requireNonnegativeNumber(data.priceCents, 'priceCents'),
    status: data.status === 'cancelled' ? 'cancelled' : 'active', updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id, status: data.status === 'cancelled' ? 'cancelled' : 'active' };
});

export const adminCancelOccurrence = onCall({ region }, async (request) => {
  requireAdmin(request.auth?.token['role']);
  const occurrenceId = requireSafeId((request.data as { occurrenceId?: string }).occurrenceId, 'occurrenceId');
  const occurrenceDate = occurrenceId.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!occurrenceDate) throw new HttpsError('invalid-argument', 'The occurrence ID must include its calendar date.');
  await db.collection('eventOccurrences').doc(occurrenceId).set({
    status: 'cancelled', dateKey: occurrenceDate, cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { occurrenceId, status: 'cancelled' };
});

export const adminUpsertWorkshop = onCall({ region }, async (request) => {
  requireAdmin(request.auth?.token['role']);
  const data = request.data as {
    id?: string; title?: string; description?: string; dates?: string[]; startTime?: string; endTime?: string;
    attendanceModes?: unknown; priceCents?: number; memberPriceCents?: number; capacity?: number;
    locationName?: string; address?: string;
  };
  const title = requireString(data.title, 'title');
  const dates = (data.dates ?? []).map((date) => requireDateKey(date, 'date'));
  if (!dates.length || dates.length > 14) throw new HttpsError('invalid-argument', 'A workshop needs between 1 and 14 dates.');
  const startTime = requireString(data.startTime, 'startTime');
  const endTime = requireString(data.endTime, 'endTime');
  const id = data.id ? requireSafeId(data.id, 'id') : `${slug(title)}_${dates[0]}`;
  const sessions = dates.map((date, index) => ({
    id: `${id}_${date}_${index + 1}`,
    startsAt: zonedWallTime(date, startTime, schoolTimezone),
    endsAt: zonedWallTime(date, endTime, schoolTimezone),
  }));
  if (sessions.some((session) => session.endsAt.toMillis() <= session.startsAt.toMillis())) throw new HttpsError('invalid-argument', 'Workshop end time must follow its start time.');
  await db.collection('workshops').doc(id).set({
    title, description: String(data.description ?? ''), sessions, timezone: schoolTimezone,
    attendanceModes: requireAttendanceModes(data.attendanceModes),
    priceCents: requireNonnegativeNumber(data.priceCents, 'priceCents'),
    memberPriceCents: requireNonnegativeNumber(data.memberPriceCents ?? data.priceCents, 'memberPriceCents'),
    capacity: requirePositiveNumber(data.capacity, 'capacity'),
    locationName: String(data.locationName ?? ''), address: String(data.address ?? ''),
    instructorId: 'nyc-school', instructorName: 'Zhong Xin Dao NYC Instructor', status: 'published',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id, sessionCount: sessions.length, status: 'published' };
});

export const getAdminScheduleCounts = onCall({ region }, async (request) => {
  requireAdmin(request.auth?.token['role']);
  const [registrations, bookings] = await Promise.all([
    db.collection('registrations').limit(1000).get(),
    db.collection('privateLessonBookings').limit(1000).get(),
  ]);
  return {
    registrations: registrations.size,
    privateBookings: bookings.size,
    onlineRegistrations: registrations.docs.filter((item) => item.get('attendanceMode') === 'online').length,
    inPersonRegistrations: registrations.docs.filter((item) => item.get('attendanceMode') === 'in_person').length,
  };
});

export const createPendingRegistration = onCall(
  { region, secrets: [zoomAccountId, zoomClientId, zoomClientSecret] },
  async (request) => {
    const uid = requireUser(request.auth?.uid);
    const data = request.data as {
      offeringId?: string;
      sessionIds?: string[];
      paymentMode?: string;
    };
    const offeringId = requireString(data.offeringId, 'offeringId');
    const sessionIds = requireStringArray(data.sessionIds, 'sessionIds');
    const paymentMode = data.paymentMode === 'entitlement' ? 'entitlement' : 'paypal';

    const offeringRef = db.collection('offerings').doc(offeringId);
    const [offeringSnap, ...sessionSnaps] = await Promise.all([
      offeringRef.get(),
      ...sessionIds.map((id) => db.collection('sessions').doc(id).get()),
    ]);
    if (!offeringSnap.exists || offeringSnap.get('status') !== 'published') {
      throw new HttpsError('not-found', 'This offering is not available.');
    }
    if (sessionSnaps.some((snap) => !snap.exists || snap.get('offeringId') !== offeringId)) {
      throw new HttpsError('failed-precondition', 'One or more selected sessions are unavailable.');
    }

    if (paymentMode === 'entitlement') await requireActiveEntitlement(uid, offeringId);

    const registrationRef = db.collection('registrations').doc();
    const amountCents = Number(offeringSnap.get('priceCents') ?? 0);
    await registrationRef.set({
      offeringId,
      offeringTitle: offeringSnap.get('title'),
      studentId: uid,
      sessionIds,
      amountCents,
      currency: offeringSnap.get('currency') ?? 'USD',
      status: paymentMode === 'paypal' ? 'pending_payment' : 'pending_entitlement_confirmation',
      paymentStatus: paymentMode === 'paypal' ? 'pending' : 'not_required',
      paymentMode,
      nextSessionAt: sessionSnaps
        .map((snap) => snap.get('startsAt'))
        .sort((a, b) => a.toMillis() - b.toMillis())[0],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (paymentMode === 'entitlement') {
      await finalizeRegistration(registrationRef.id, undefined);
    }
    return {
      registrationId: registrationRef.id,
      status: paymentMode === 'paypal' ? 'pending_payment' : 'confirmed',
    };
  },
);

export const createPayPalOrder = onCall(
  { region, secrets: [payPalClientId, payPalSecret] },
  async (request) => {
    const uid = requireUser(request.auth?.uid);
    const registrationId = requireString(
      (request.data as { registrationId?: string }).registrationId,
      'registrationId',
    );
    const registrationRef = db.collection('registrations').doc(registrationId);
    const registration = await registrationRef.get();
    if (!registration.exists || registration.get('studentId') !== uid)
      throw new HttpsError('not-found', 'Registration not found.');
    if (registration.get('status') !== 'pending_payment')
      throw new HttpsError('failed-precondition', 'Registration is not awaiting payment.');

    const order = await paypalRequest(
      '/v2/checkout/orders',
      payPalClientId.value(),
      payPalSecret.value(),
      {
        method: 'POST',
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              custom_id: registrationId,
              description: registration.get('offeringTitle'),
              amount: {
                currency_code: registration.get('currency'),
                value: (Number(registration.get('amountCents')) / 100).toFixed(2),
              },
            },
          ],
        }),
      },
    );
    const providerOrderId = requireString(order['id'], 'PayPal order ID');
    await registrationRef.update({ providerOrderId, updatedAt: FieldValue.serverTimestamp() });
    return { orderId: providerOrderId };
  },
);

export const handlePayPalWebhook = onRequest(
  {
    region,
    secrets: [
      payPalClientId,
      payPalSecret,
      payPalWebhookId,
      zoomAccountId,
      zoomClientId,
      zoomClientSecret,
    ],
  },
  async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.status(405).send('Method not allowed');
        return;
      }
      const event = request.body as Json;
      await verifyPayPalWebhook(request.headers, event);
      const eventId = requireString(event['id'], 'event ID');
      const eventRef = db.collection('webhookEvents').doc(`paypal_${eventId}`);
      if ((await eventRef.get()).exists) {
        response.status(200).send('Already processed');
        return;
      }

      if (event['event_type'] === 'PAYMENT.CAPTURE.COMPLETED') {
        const resource = event['resource'] as Json | undefined;
        const registrationId = requireString(resource?.['custom_id'], 'registration custom ID');
        const transactionId = requireString(resource?.['id'], 'capture ID');
        await finalizeRegistration(registrationId, transactionId);
      }
      await eventRef.set({ type: event['event_type'], processedAt: FieldValue.serverTimestamp() });
      response.status(200).send('OK');
    } catch (error) {
      logger.error('PayPal webhook failed', error);
      response.status(500).send('Webhook processing failed');
    }
  },
);

export const getSessionAccess = onCall({ region }, async (request) => {
  const uid = requireUser(request.auth?.uid);
  const sessionId = requireString((request.data as { sessionId?: string }).sessionId, 'sessionId');
  const role = request.auth?.token['role'];
  const [session, grant, meeting] = await Promise.all([
    db.collection('sessions').doc(sessionId).get(),
    db.collection('accessGrants').doc(`${uid}_${sessionId}`).get(),
    db.collection('videoMeetings').doc(`zoom_${sessionId}`).get(),
  ]);
  const privileged = role === 'admin' || (session.exists && session.get('instructorId') === uid);
  if (!privileged && !grant.exists)
    throw new HttpsError('permission-denied', 'No confirmed access for this session.');
  if (!meeting.exists || meeting.get('status') !== 'ready')
    throw new HttpsError('failed-precondition', 'Meeting access is not ready yet.');

  return {
    sessionId,
    topic: meeting.get('topic'),
    startsAt: (meeting.get('startsAt') as Timestamp).toDate().toISOString(),
    joinUrl: privileged ? meeting.get('startUrl') : meeting.get('joinUrl'),
    passcode: meeting.get('passcode') ?? null,
  };
});

async function finalizeRegistration(registrationId: string, transactionId?: string): Promise<void> {
  const registrationRef = db.collection('registrations').doc(registrationId);
  const registration = await registrationRef.get();
  if (!registration.exists) throw new Error(`Registration ${registrationId} does not exist.`);
  if (registration.get('status') === 'cancelled')
    throw new Error('Cancelled registrations cannot be confirmed.');

  const updates: Promise<unknown>[] = [];
  if (transactionId) {
    updates.push(
      db
        .collection('payments')
        .doc(transactionId)
        .set(
          {
            registrationId,
            studentId: registration.get('studentId'),
            provider: 'paypal',
            providerTransactionId: transactionId,
            amountCents: registration.get('amountCents'),
            currency: registration.get('currency'),
            status: 'paid',
            verifiedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
    );
  }
  updates.push(
    registrationRef.update({
      status: 'confirmed',
      paymentStatus: transactionId ? 'paid' : registration.get('paymentStatus'),
      providerTransactionId: transactionId ?? null,
      confirmedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );
  const bookingId = registration.get('bookingId') as string | undefined;
  if (bookingId) {
    updates.push(db.collection('privateLessonBookings').doc(bookingId).set({
      status: 'confirmed', holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
  }
  await Promise.all(updates);

  const sessionIds = registration.get('sessionIds') as string[];
  const attendanceMode = registration.get('attendanceMode') as AttendanceMode | undefined;
  for (const sessionId of sessionIds) {
    if (attendanceMode === 'in_person') continue;
    await ensureZoomMeeting(sessionId);
    await db
      .collection('accessGrants')
      .doc(`${registration.get('studentId')}_${sessionId}`)
      .set(
        {
          studentId: registration.get('studentId'),
          sessionId,
          registrationId,
          status: 'active',
          grantedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
}

async function ensureZoomMeeting(sessionId: string): Promise<void> {
  const meetingRef = db.collection('videoMeetings').doc(`zoom_${sessionId}`);
  const ownerToken = randomUUID();
  let shouldCreate = false;
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(meetingRef);
    if (existing.exists && existing.get('status') === 'ready') return;
    const lease = existing.get('leaseExpiresAt') as Timestamp | undefined;
    if (
      existing.exists &&
      existing.get('status') === 'creating' &&
      lease &&
      lease.toMillis() > Date.now()
    )
      return;
    shouldCreate = true;
    transaction.set(
      meetingRef,
      {
        provider: 'zoom',
        sessionId,
        status: 'creating',
        ownerToken,
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + 2 * 60 * 1000),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  if (!shouldCreate) {
    const current = await meetingRef.get();
    if (current.get('status') === 'ready') return;
    throw new Error(`Zoom meeting creation is already in progress for ${sessionId}.`);
  }

  const session = await db.collection('sessions').doc(sessionId).get();
  if (!session.exists) throw new Error(`Session ${sessionId} does not exist.`);
  const accessToken = await getZoomAccessToken();
  const startsAt = session.get('startsAt') as Timestamp;
  const zoomUser = session.get('zoomUserId') ?? 'me';
  const zoomResponse = await fetch(
    `https://api.zoom.us/v2/users/${encodeURIComponent(zoomUser)}/meetings`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: session.get('title'),
        type: 2,
        start_time: startsAt.toDate().toISOString(),
        duration: session.get('durationMinutes') ?? 60,
        timezone: session.get('timezone') ?? 'America/New_York',
        settings: {
          waiting_room: true,
          join_before_host: false,
          approval_type: 2,
          mute_upon_entry: true,
        },
      }),
    },
  );
  if (!zoomResponse.ok) throw new Error(`Zoom meeting creation returned ${zoomResponse.status}.`);
  const zoomMeeting = (await zoomResponse.json()) as Json;
  await meetingRef.set(
    {
      providerMeetingId: String(zoomMeeting['id']),
      topic: zoomMeeting['topic'],
      startsAt,
      joinUrl: zoomMeeting['join_url'],
      startUrl: zoomMeeting['start_url'],
      passcode: zoomMeeting['password'] ?? null,
      status: 'ready',
      ownerToken: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function getZoomAccessToken(): Promise<string> {
  const credentials = Buffer.from(`${zoomClientId.value()}:${zoomClientSecret.value()}`).toString(
    'base64',
  );
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'account_credentials',
      account_id: zoomAccountId.value(),
    }),
  });
  if (!response.ok) throw new Error(`Zoom authorization returned ${response.status}.`);
  return requireString(((await response.json()) as Json)['access_token'], 'Zoom access token');
}

async function requireActiveEntitlement(uid: string, offeringId: string): Promise<void> {
  const snapshot = await db
    .collection('entitlements')
    .where('studentId', '==', uid)
    .where('offeringIds', 'array-contains', offeringId)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (snapshot.empty)
    throw new HttpsError('permission-denied', 'No active entitlement covers this training.');
  const expiresAt = snapshot.docs[0].get('expiresAt') as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now())
    throw new HttpsError('permission-denied', 'This entitlement has expired.');
}

async function verifyPayPalWebhook(
  headers: Record<string, string | string[] | undefined>,
  event: Json,
): Promise<void> {
  const result = await paypalRequest(
    '/v1/notifications/verify-webhook-signature',
    payPalClientId.value(),
    payPalSecret.value(),
    {
      method: 'POST',
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: payPalWebhookId.value(),
        webhook_event: event,
      }),
    },
  );
  if (result['verification_status'] !== 'SUCCESS')
    throw new Error('PayPal webhook signature was not valid.');
}

async function paypalRequest(
  path: string,
  clientId: string,
  clientSecret: string,
  init: RequestInit,
): Promise<Json> {
  const apiBase = payPalApiBase.value();
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenResponse = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!tokenResponse.ok) throw new Error(`PayPal authorization returned ${tokenResponse.status}.`);
  const token = requireString(
    ((await tokenResponse.json()) as Json)['access_token'],
    'PayPal access token',
  );
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`PayPal request returned ${response.status}.`);
  return response.json() as Promise<Json>;
}

function requireUser(uid: string | undefined): string {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in is required.');
  return uid;
}

function requireAdmin(role: unknown): void {
  if (role !== 'admin') throw new HttpsError('permission-denied', 'Administrator access is required.');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpsError('invalid-argument', `${field} is required.`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 20 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new HttpsError('invalid-argument', `${field} must contain between 1 and 20 IDs.`);
  }
  return [...new Set(value as string[])];
}

function requireDateKey(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T12:00:00Z`))) {
    throw new HttpsError('invalid-argument', `${field} must be a calendar date.`);
  }
  return result;
}

function requireSafeId(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!/^[A-Za-z0-9_-]{2,160}$/.test(result)) throw new HttpsError('invalid-argument', `${field} is invalid.`);
  return result;
}

function requireAttendanceMode(value: unknown): AttendanceMode {
  if (value !== 'online' && value !== 'in_person') throw new HttpsError('invalid-argument', 'attendanceMode is invalid.');
  return value;
}

function requireAttendanceModes(value: unknown): AttendanceMode[] {
  if (!Array.isArray(value) || !value.length || value.some((mode) => mode !== 'online' && mode !== 'in_person')) {
    throw new HttpsError('invalid-argument', 'attendanceModes is invalid.');
  }
  return [...new Set(value as AttendanceMode[])];
}

function requireFutureTimestamp(value: unknown, field: string): Timestamp {
  const millis = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis) || millis < Date.now() - 60 * 60 * 1000 || millis > Date.now() + 400 * 24 * 60 * 60 * 1000) {
    throw new HttpsError('invalid-argument', `${field} is outside the scheduling window.`);
  }
  return Timestamp.fromMillis(millis);
}

async function resolveScheduleProduct(productId: string): Promise<{ title: string; type: string; priceCents: number; attendanceModes: AttendanceMode[]; capacity?: number; inPersonCapacity?: number; locationName?: string; address?: string; sessions?: Array<{ id: string; startsAt: Timestamp; endsAt: Timestamp }> }> {
  const defaults: Record<string, { title: string; type: string; priceCents: number; attendanceModes: AttendanceMode[]; capacity?: number; inPersonCapacity?: number; locationName?: string; address?: string }> = {
    'daytime-online-class': { title: 'Daytime Online Class', type: 'online_class', priceCents: 2800, attendanceModes: ['online'], capacity: 30 },
    'wednesday-evening-class': { title: 'Wednesday Evening Manhattan Class', type: 'hybrid_class', priceCents: 4000, attendanceModes: ['in_person', 'online'], capacity: 60, inPersonCapacity: 24, locationName: 'Manhattan training space', address: 'Manhattan, New York, NY' },
    'mindfulness-in-motion-weekend': { title: 'Mindfulness in Motion Workshop', type: 'workshop', priceCents: 18500, attendanceModes: ['in_person'], capacity: 36, locationName: 'Manhattan training space', address: 'Manhattan, New York, NY' },
  };
  if (defaults[productId]) return defaults[productId];
  const recurring = await db.collection('recurringSchedules').doc(productId).get();
  if (recurring.exists && recurring.get('status') === 'active') {
    return {
      title: recurring.get('title'), type: recurring.get('type'),
      priceCents: Number(recurring.get('priceCents') ?? 0),
      attendanceModes: recurring.get('attendanceModes') as AttendanceMode[],
      capacity: Number(recurring.get('capacity') ?? 0) || undefined,
      inPersonCapacity: Number(recurring.get('inPersonCapacity') ?? 0) || undefined,
      locationName: recurring.get('locationName') ?? undefined,
      address: recurring.get('address') ?? undefined,
    };
  }
  const workshop = await db.collection('workshops').doc(productId).get();
  if (!workshop.exists || workshop.get('status') !== 'published') throw new HttpsError('not-found', 'This event is not available.');
  return {
    title: workshop.get('title'), type: 'workshop', priceCents: Number(workshop.get('priceCents') ?? 0),
    attendanceModes: workshop.get('attendanceModes') as AttendanceMode[],
    capacity: Number(workshop.get('capacity') ?? 0) || undefined,
    locationName: workshop.get('locationName') ?? undefined,
    address: workshop.get('address') ?? undefined,
    sessions: workshop.get('sessions') as Array<{ id: string; startsAt: Timestamp; endsAt: Timestamp }>,
  };
}

function zonedWallTime(dateKey: string, time: string, timeZone: string): Timestamp {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(candidate)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const shown = Date.UTC(parts['year'], parts['month'] - 1, parts['day'], parts['hour'], parts['minute']);
    candidate -= shown - target;
  }
  return Timestamp.fromMillis(candidate);
}

function requireNonnegativeNumber(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new HttpsError('invalid-argument', `${field} is invalid.`);
  return Math.round(result);
}

function requirePositiveNumber(value: unknown, field: string): number {
  const result = requireNonnegativeNumber(value, field);
  if (result < 1) throw new HttpsError('invalid-argument', `${field} must be positive.`);
  return result;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'workshop';
}
