import { Injectable, inject, signal } from '@angular/core';
import { collection, getDocs, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { TrainingOffering } from '../models/training.models';
import { FirebaseService } from './firebase.service';

const HOUR = 60 * 60 * 1000;

const DEMO_OFFERINGS: TrainingOffering[] = [
  {
    id: 'online-foundations', title: 'Online Foundations', eyebrow: 'Weekly group class',
    description: 'Build the spinning-hands principles, alignment, and listening skill through guided partner-aware practice.',
    type: 'group', deliveryMode: 'online', priceCents: 2800, currency: 'USD',
    nextStartAt: new Date(Date.now() + 28 * HOUR), timezone: 'America/New_York', durationLabel: '75 minutes',
    instructorName: 'Senior Instructor', level: 'All levels', sessionCount: 1, status: 'published',
  },
  {
    id: 'refining-contact', title: 'Refining Contact', eyebrow: 'Four-week online series',
    description: 'A progressive small-group series exploring fullness, emptiness, matching, and the neutral point.',
    type: 'group', deliveryMode: 'online', priceCents: 9600, currency: 'USD',
    nextStartAt: new Date(Date.now() + 76 * HOUR), timezone: 'America/New_York', durationLabel: '4 × 90 minutes',
    instructorName: 'Senior Instructor', level: 'Level 2+', sessionCount: 4, status: 'published',
  },
  {
    id: 'weekend-intensive', title: 'Stillness in Motion', eyebrow: 'Weekend workshop',
    description: 'Four live sessions connecting mindfulness, structure, and change through solo and partner exercises.',
    type: 'workshop', deliveryMode: 'online', priceCents: 18500, currency: 'USD',
    nextStartAt: new Date(Date.now() + 8 * 24 * HOUR), timezone: 'America/New_York', durationLabel: '4 sessions · 2 days',
    instructorName: 'Guest Faculty', level: 'All levels', sessionCount: 4, status: 'published',
  },
  {
    id: 'private-lesson', title: 'Private Online Lesson', eyebrow: 'One-to-one training',
    description: 'Focused instruction shaped around your current practice, questions, and next area of development.',
    type: 'private', deliveryMode: 'online', priceCents: 12000, currency: 'USD',
    nextStartAt: new Date(Date.now() + 4 * 24 * HOUR), timezone: 'America/New_York', durationLabel: '60 minutes',
    instructorName: 'Choose an instructor', level: 'Personalized', sessionCount: 1, status: 'published',
  },
];

@Injectable({ providedIn: 'root' })
export class TrainingService {
  private readonly firebase = inject(FirebaseService);
  readonly offerings = signal<TrainingOffering[]>(DEMO_OFFERINGS);
  readonly loading = signal(false);
  readonly usingDemoData = signal(!this.firebase.configured);

  constructor() {
    void this.loadPublishedOfferings();
  }

  async loadPublishedOfferings(): Promise<void> {
    if (!this.firebase.firestore) return;
    this.loading.set(true);
    try {
      const snapshot = await getDocs(query(
        collection(this.firebase.firestore, 'offerings'),
        where('status', '==', 'published'),
        orderBy('nextStartAt', 'asc'),
      ));

      const offerings = snapshot.docs.map((item) => {
        const data = item.data() as Omit<TrainingOffering, 'id' | 'nextStartAt'> & { nextStartAt: Timestamp };
        return { ...data, id: item.id, nextStartAt: data.nextStartAt.toDate() };
      });
      if (offerings.length) {
        this.offerings.set(offerings);
        this.usingDemoData.set(false);
      }
    } finally {
      this.loading.set(false);
    }
  }
}
