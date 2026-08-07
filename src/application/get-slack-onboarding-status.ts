import { z } from 'zod';
import type {
  SlackOnboardingStatus,
  SlackOnboardingStatusRepository,
} from './ports/slack-onboarding-status-repository.js';

const cognitoSubjectSchema = z.uuid();

/** Returns only safe, membership-scoped Slack connection metadata. */
export class GetSlackOnboardingStatus {
  public constructor(
    private readonly repository: SlackOnboardingStatusRepository,
  ) {}

  public async execute(cognitoSubject: string): Promise<SlackOnboardingStatus> {
    return this.repository.findByCognitoSubject(
      cognitoSubjectSchema.parse(cognitoSubject),
    );
  }
}
