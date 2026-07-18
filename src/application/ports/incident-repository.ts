import type { Incident } from '../../domain/incident.js';

export interface CreateIncidentResult {
  readonly created: boolean;
  readonly incident: Incident;
}

export interface IncidentRepository {
  createIfAbsent(incident: Incident): Promise<CreateIncidentResult>;
  findById(tenantId: string, incidentId: string): Promise<Incident | null>;
  save(incident: Incident, expectedVersion: number): Promise<void>;
}

export class OptimisticConcurrencyError extends Error {
  public constructor(message = 'Incident was modified concurrently') {
    super(message);
    this.name = 'OptimisticConcurrencyError';
  }
}
