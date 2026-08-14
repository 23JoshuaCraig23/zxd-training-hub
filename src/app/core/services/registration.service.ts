import { Injectable, inject } from '@angular/core';
import { collection, getDocs, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { SessionAccess, StudentRegistration } from '../models/training.models';
import { FirebaseService } from './firebase.service';

@Injectable({ providedIn: 'root' })
export class RegistrationService {
  private readonly firebase = inject(FirebaseService);

  async loadForStudent(studentId: string): Promise<StudentRegistration[]> {
    if (!this.firebase.firestore) return [];
    const snapshot = await getDocs(query(
      collection(this.firebase.firestore, 'registrations'),
      where('studentId', '==', studentId),
      orderBy('createdAt', 'desc'),
    ));
    return snapshot.docs.map((item) => {
      const data = item.data() as Omit<StudentRegistration, 'id' | 'nextSessionAt'> & { nextSessionAt?: Timestamp };
      return { ...data, id: item.id, nextSessionAt: data.nextSessionAt?.toDate() };
    });
  }

  async createPending(offeringId: string, sessionIds: string[], paymentMode: 'paypal' | 'entitlement' = 'paypal') {
    if (!this.firebase.functions) throw new Error('Firebase Functions is not configured.');
    const call = httpsCallable<
      { offeringId: string; sessionIds: string[]; paymentMode: 'paypal' | 'entitlement' },
      { registrationId: string; status: string }
    >(this.firebase.functions, 'createPendingRegistration');
    return (await call({ offeringId, sessionIds, paymentMode })).data;
  }

  async getSessionAccess(sessionId: string): Promise<SessionAccess> {
    if (!this.firebase.functions) throw new Error('Firebase Functions is not configured.');
    const call = httpsCallable<{ sessionId: string }, SessionAccess>(this.firebase.functions, 'getSessionAccess');
    return (await call({ sessionId })).data;
  }
}
