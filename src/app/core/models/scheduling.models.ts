export type ScheduleEventType = 'online_class' | 'hybrid_class' | 'private_lesson' | 'workshop';
export type AttendanceMode = 'online' | 'in_person';
export type CalendarFilter = 'all' | 'online' | 'in_person' | 'private_lesson' | 'workshop' | 'mine';
export type CalendarView = 'month' | 'week' | 'agenda';

export interface CalendarEvent {
  id: string;
  productId: string;
  type: ScheduleEventType;
  title: string;
  description: string;
  start: Date;
  end: Date;
  timezone: 'America/New_York';
  instructorId: string;
  instructorName: string;
  attendanceModes: AttendanceMode[];
  locationName?: string;
  address?: string;
  mapUrl?: string;
  priceCents: number;
  memberPriceCents?: number;
  capacity?: number;
  inPersonCapacity?: number;
  registrationDeadline?: Date;
  status: 'scheduled' | 'cancelled';
  recurrenceId?: string;
  dateKey: string;
  startTime: string;
  endTime: string;
  slotId?: string;
  workshopSessionIds?: string[];
}

export interface ScheduleRegistrationResult {
  registrationId?: string;
  bookingId?: string;
  status: string;
}

export interface AdminScheduleCounts {
  registrations: number;
  privateBookings: number;
  onlineRegistrations: number;
  inPersonRegistrations: number;
}
