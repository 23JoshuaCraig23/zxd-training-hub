export type OfferingType = 'group' | 'private' | 'workshop';
export type DeliveryMode = 'online' | 'in_person' | 'hybrid';

export interface TrainingOffering {
  id: string;
  title: string;
  eyebrow: string;
  description: string;
  type: OfferingType;
  deliveryMode: DeliveryMode;
  priceCents: number;
  currency: string;
  nextStartAt: Date;
  timezone: string;
  durationLabel: string;
  instructorName: string;
  level: string;
  sessionCount: number;
  status: 'draft' | 'published' | 'archived';
}

export interface StudentRegistration {
  id: string;
  offeringId: string;
  offeringTitle: string;
  studentId: string;
  sessionIds: string[];
  status: 'pending_payment' | 'confirmed' | 'cancelled';
  paymentStatus: 'not_required' | 'pending' | 'paid' | 'refunded';
  nextSessionAt?: Date;
}

export interface SessionAccess {
  sessionId: string;
  topic: string;
  startsAt: string;
  joinUrl: string;
  passcode?: string;
}
