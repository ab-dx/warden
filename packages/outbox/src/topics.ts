import type { Event } from '@warden/contracts';

type PayloadCase = NonNullable<Event['payload']['case']>;

// the aggregatetype column holds the topic stem, which is what debezium routes on
export const topicStem: Record<PayloadCase, string> = {
  callReceived: 'calls',
  decisionMade: 'decisions',
  approvalRequested: 'approvals',
  approvalResolved: 'approvals',
  paymentExecuted: 'payments',
  reservationReleased: 'payments',
  untrustedContentObserved: 'untrusted-content',
};

export const topicFor = (stem: string) => `warden.${stem}.v1`;
