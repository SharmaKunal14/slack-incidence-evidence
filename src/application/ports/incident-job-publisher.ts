import type { IncidentReviewJob } from '../../domain/incident-review-job.js';

export interface IncidentJobPublisher {
  publish(job: IncidentReviewJob): Promise<void>;
}
