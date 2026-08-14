import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { defineJsonSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { randomUUID } from 'node:crypto';

initializeApp();
const db = getFirestore();
const region = 'us-central1';

const zoomConfig = defineJsonSecret('ZOOM_CONFIG');
const paypalConfig = defineJsonSecret('PAYPAL_CONFIG');

interface ZoomConfig { accountId: string; clientId: string; clientSecret: string }
interface PayPalConfig { clientId: string; clientSecret: string; webhookId: string; apiBase?: string }

type Json = Record<string, unknown>;

export const createPendingRegistration = onCall({ region, secrets: [zoomConfig] }, async (request) => {
  const uid = requireUser(request.auth?.uid);
  const data = request.data as { offeringId?: string; sessionIds?: string[]; paymentMode?: string };
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
    nextSessionAt: sessionSnaps.map((snap) => snap.get('startsAt')).sort((a, b) => a.toMillis() - b.toMillis())[0],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (paymentMode === 'entitlement') {
    await finalizeRegistration(registrationRef.id, undefined);
  }
  return { registrationId: registrationRef.id, status: paymentMode === 'paypal' ? 'pending_payment' : 'confirmed' };
});

export const createPayPalOrder = onCall(
  { region, secrets: [paypalConfig] },
  async (request) => {
    const uid = requireUser(request.auth?.uid);
    const registrationId = requireString((request.data as { registrationId?: string }).registrationId, 'registrationId');
    const registrationRef = db.collection('registrations').doc(registrationId);
    const registration = await registrationRef.get();
    if (!registration.exists || registration.get('studentId') !== uid) throw new HttpsError('not-found', 'Registration not found.');
    if (registration.get('status') !== 'pending_payment') throw new HttpsError('failed-precondition', 'Registration is not awaiting payment.');

    const order = await paypalRequest('/v2/checkout/orders', paypalConfig.value() as PayPalConfig, {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          custom_id: registrationId,
          description: registration.get('offeringTitle'),
          amount: {
            currency_code: registration.get('currency'),
            value: (Number(registration.get('amountCents')) / 100).toFixed(2),
          },
        }],
      }),
    });
    const providerOrderId = requireString(order['id'], 'PayPal order ID');
    await registrationRef.update({ providerOrderId, updatedAt: FieldValue.serverTimestamp() });
    return { orderId: providerOrderId };
  },
);

export const handlePayPalWebhook = onRequest(
  { region, secrets: [paypalConfig, zoomConfig] },
  async (request, response) => {
    try {
      if (request.method !== 'POST') { response.status(405).send('Method not allowed'); return; }
      const event = request.body as Json;
      await verifyPayPalWebhook(request.headers, event);
      const eventId = requireString(event['id'], 'event ID');
      const eventRef = db.collection('webhookEvents').doc(`paypal_${eventId}`);
      if ((await eventRef.get()).exists) { response.status(200).send('Already processed'); return; }

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
  if (!privileged && !grant.exists) throw new HttpsError('permission-denied', 'No confirmed access for this session.');
  if (!meeting.exists || meeting.get('status') !== 'ready') throw new HttpsError('failed-precondition', 'Meeting access is not ready yet.');

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
  if (registration.get('status') === 'cancelled') throw new Error('Cancelled registrations cannot be confirmed.');

  const updates: Promise<unknown>[] = [];
  if (transactionId) {
    updates.push(db.collection('payments').doc(transactionId).set({
      registrationId,
      studentId: registration.get('studentId'),
      provider: 'paypal',
      providerTransactionId: transactionId,
      amountCents: registration.get('amountCents'),
      currency: registration.get('currency'),
      status: 'paid',
      verifiedAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
  }
  updates.push(registrationRef.update({
    status: 'confirmed',
    paymentStatus: transactionId ? 'paid' : registration.get('paymentStatus'),
    providerTransactionId: transactionId ?? null,
    confirmedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }));
  await Promise.all(updates);

  const sessionIds = registration.get('sessionIds') as string[];
  for (const sessionId of sessionIds) {
    await ensureZoomMeeting(sessionId);
    await db.collection('accessGrants').doc(`${registration.get('studentId')}_${sessionId}`).set({
      studentId: registration.get('studentId'),
      sessionId,
      registrationId,
      status: 'active',
      grantedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
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
    if (existing.exists && existing.get('status') === 'creating' && lease && lease.toMillis() > Date.now()) return;
    shouldCreate = true;
    transaction.set(meetingRef, {
      provider: 'zoom', sessionId, status: 'creating', ownerToken,
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + 2 * 60 * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
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
  const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(zoomUser)}/meetings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: session.get('title'),
      type: 2,
      start_time: startsAt.toDate().toISOString(),
      duration: session.get('durationMinutes') ?? 60,
      timezone: session.get('timezone') ?? 'America/New_York',
      settings: { waiting_room: true, join_before_host: false, approval_type: 2, mute_upon_entry: true },
    }),
  });
  if (!zoomResponse.ok) throw new Error(`Zoom meeting creation returned ${zoomResponse.status}.`);
  const zoomMeeting = await zoomResponse.json() as Json;
  await meetingRef.set({
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
  }, { merge: true });
}

async function getZoomAccessToken(): Promise<string> {
  const zoom = zoomConfig.value() as ZoomConfig;
  const credentials = Buffer.from(`${zoom.clientId}:${zoom.clientSecret}`).toString('base64');
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'account_credentials', account_id: zoom.accountId }),
  });
  if (!response.ok) throw new Error(`Zoom authorization returned ${response.status}.`);
  return requireString((await response.json() as Json)['access_token'], 'Zoom access token');
}

async function requireActiveEntitlement(uid: string, offeringId: string): Promise<void> {
  const snapshot = await db.collection('entitlements')
    .where('studentId', '==', uid).where('offeringIds', 'array-contains', offeringId).where('status', '==', 'active').limit(1).get();
  if (snapshot.empty) throw new HttpsError('permission-denied', 'No active entitlement covers this training.');
  const expiresAt = snapshot.docs[0].get('expiresAt') as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) throw new HttpsError('permission-denied', 'This entitlement has expired.');
}

async function verifyPayPalWebhook(headers: Record<string, string | string[] | undefined>, event: Json): Promise<void> {
  const paypal = paypalConfig.value() as PayPalConfig;
  const result = await paypalRequest('/v1/notifications/verify-webhook-signature', paypal, {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'], webhook_id: paypal.webhookId, webhook_event: event,
    }),
  });
  if (result['verification_status'] !== 'SUCCESS') throw new Error('PayPal webhook signature was not valid.');
}

async function paypalRequest(path: string, config: PayPalConfig, init: RequestInit): Promise<Json> {
  const apiBase = config.apiBase ?? 'https://api-m.sandbox.paypal.com';
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const tokenResponse = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!tokenResponse.ok) throw new Error(`PayPal authorization returned ${tokenResponse.status}.`);
  const token = requireString((await tokenResponse.json() as Json)['access_token'], 'PayPal access token');
  const response = await fetch(`${apiBase}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`PayPal request returned ${response.status}.`);
  return response.json() as Promise<Json>;
}

function requireUser(uid: string | undefined): string {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in is required.');
  return uid;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpsError('invalid-argument', `${field} is required.`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some((item) => typeof item !== 'string')) {
    throw new HttpsError('invalid-argument', `${field} must contain between 1 and 20 IDs.`);
  }
  return [...new Set(value as string[])];
}
