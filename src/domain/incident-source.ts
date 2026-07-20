export const INCIDENT_SOURCE_STATUSES = [
  'PLANNED',
  'COLLECTING',
  'COMPLETE',
  'PARTIAL',
  'INACCESSIBLE',
  'REVOKED',
  'FAILED',
  'EXCLUDED',
] as const;

export type IncidentSourceStatus = (typeof INCIDENT_SOURCE_STATUSES)[number];

export interface CreateIncidentSource {
  readonly id: string;
  readonly provider: 'SLACK';
  readonly sourceKind: 'SLACK_CHANNEL' | 'SLACK_THREAD';
  readonly sourceRole: 'PRIMARY' | 'ADDITIONAL' | 'ANCHOR';
  readonly providerSourceId: string;
  readonly idempotencyIdentity: string;
  readonly requestedStartAt: Date;
  readonly requestedEndAt: Date;
  readonly anchorThreadTimestamps: readonly string[];
}
