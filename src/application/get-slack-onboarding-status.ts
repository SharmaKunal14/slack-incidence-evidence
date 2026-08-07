import { cognitoSubjectSchema } from './identity/cognito-subject.js';
import type {
  SlackOnboardingStatus,
  SlackOnboardingStatusRepository,
} from './ports/slack-onboarding-status-repository.js';

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
