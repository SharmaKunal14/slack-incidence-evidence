import type { Incident } from '../../domain/incident.js';
import type { CreateIncidentSource } from '../../domain/incident-source.js';

export interface CreateIncidentResult {
  readonly created: boolean;
  readonly incident: Incident;
  readonly sourceIds?: readonly string[];
}

export interface IncidentRepository {
  createIfAbsent(
    incident: Incident,
    sources?: readonly CreateIncidentSource[],
  ): Promise<CreateIncidentResult>;
  findById(tenantId: string, incidentId: string): Promise<Incident | null>;
  save(incident: Incident, expectedVersion: number): Promise<void>;
}

export class OptimisticConcurrencyError extends Error {
  public constructor(message = 'Incident was modified concurrently') {
    super(message);
    this.name = 'OptimisticConcurrencyError';
  }
}
