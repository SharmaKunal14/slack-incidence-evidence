import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PolicyStatement {
  readonly Sid?: string;
  readonly Action?: string | readonly string[];
  readonly Resource?: unknown;
  readonly Condition?: Record<string, unknown>;
}

interface CloudFormationResource {
  readonly Type?: string;
  readonly Properties?: {
    readonly PolicyDocument?: {
      readonly Statement?: readonly PolicyStatement[];
    };
  };
}

interface CloudFormationTemplate {
  readonly Resources?: Record<string, CloudFormationResource>;
}

async function loadTemplate(): Promise<CloudFormationTemplate> {
  const contents = await readFile(
    resolve('infrastructure/bootstrap/deployment-role.json'),
    'utf8',
  );
  return JSON.parse(contents) as CloudFormationTemplate;
}

function policyStatements(
  template: CloudFormationTemplate,
): readonly PolicyStatement[] {
  return Object.values(template.Resources ?? {}).flatMap(
    (resource) => resource.Properties?.PolicyDocument?.Statement ?? [],
  );
}

describe('deployment bootstrap policy', () => {
  it('resolves the current GitHub OIDC subject prefix', async () => {
    const script = await readFile(
      resolve('infrastructure/bootstrap/deploy.sh'),
      'utf8',
    );
    const runbook = await readFile(
      resolve('infrastructure/bootstrap/README.md'),
      'utf8',
    );

    expect(script).toContain(
      'repos/${github_repository}/actions/oidc/customization/sub',
    );
    expect(script).toContain("--jq '.sub_claim_prefix'");
    expect(script).toContain(
      'github_subject="${github_subject_prefix}:environment:${environment}"',
    );
    expect(runbook).toContain(
      "--github-repository 'SharmaKunal14/slack-incidence-evidence'",
    );
    expect(runbook).not.toContain(
      'repo:SharmaKunal14/slack-incidence-evidence:environment:development',
    );
  });

  it('never grants wildcard actions or administrative managed policies', async () => {
    const template = await loadTemplate();
    const statements = policyStatements(template);
    const actions = statements.flatMap((statement) =>
      typeof statement.Action === 'string'
        ? [statement.Action]
        : (statement.Action ?? []),
    );

    expect(actions).not.toContain('*');
    expect(actions).not.toContain('iam:AttachRolePolicy');
    expect(actions).not.toContain('iam:CreatePolicy');
    expect(actions).not.toContain('iam:DeleteRolePermissionsBoundary');
  });

  it('keeps every managed policy within the AWS size limit', async () => {
    const template = await loadTemplate();
    for (const [name, resource] of Object.entries(template.Resources ?? {})) {
      if (resource.Type !== 'AWS::IAM::ManagedPolicy') {
        continue;
      }
      expect(
        JSON.stringify(resource.Properties?.PolicyDocument).length,
        `${name} exceeds the 6,144-character managed-policy limit`,
      ).toBeLessThanOrEqual(6_144);
    }
  });

  it('cannot manage or pass the unbounded GitHub deployment role', async () => {
    const template = await loadTemplate();
    const policy = JSON.stringify([
      template.Resources?.['RuntimeRoleManagementPolicy']?.Properties
        ?.PolicyDocument,
      template.Resources?.['OnboardingRoleManagementPolicy']?.Properties
        ?.PolicyDocument,
    ]);

    expect(policy).not.toContain('github-deploy');
    expect(policy).not.toContain('role/${ProjectName}-${Environment}-*');
  });

  it('requires the boundary and deployment tags when creating roles', async () => {
    const template = await loadTemplate();
    const createRoles = policyStatements(template).filter(
      (statement) => statement.Action === 'iam:CreateRole',
    );

    expect(createRoles).toHaveLength(3);
    for (const statement of createRoles) {
      expect(statement.Condition).toMatchObject({
        StringEquals: {
          'aws:RequestTag/Application': { Ref: 'ProjectName' },
          'aws:RequestTag/Environment': { Ref: 'Environment' },
          'aws:RequestTag/ManagedBy': 'Terraform',
        },
      });
    }
    const boundaryReferences = createRoles.map((statement) => {
      const stringEquals = statement.Condition?.['StringEquals'];
      if (typeof stringEquals !== 'object' || stringEquals === null) {
        return undefined;
      }
      return (stringEquals as Record<string, unknown>)[
        'iam:PermissionsBoundary'
      ];
    });
    expect(boundaryReferences).toEqual(
      expect.arrayContaining([
        { Ref: 'LambdaRolePermissionsBoundary' },
        { Ref: 'WorkflowRolePermissionsBoundary' },
      ]),
    );
  });

  it('allows managing and passing only the three exact onboarding roles', async () => {
    const template = await loadTemplate();
    const policy =
      template.Resources?.['OnboardingRoleManagementPolicy']?.Properties
        ?.PolicyDocument;
    const statements = policy?.Statement ?? [];
    const expectedResources = [
      {
        'Fn::Sub':
          'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${ProjectName}-${Environment}-slack-onboarding-start-role',
      },
      {
        'Fn::Sub':
          'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${ProjectName}-${Environment}-slack-onboarding-callback-role',
      },
      {
        'Fn::Sub':
          'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${ProjectName}-${Environment}-slack-installation-disconnect-role',
      },
    ];

    expect(statements.map(({ Sid }) => Sid)).toEqual([
      'CreateBoundedOnboardingRoles',
      'ManageExactOnboardingRoles',
      'SetExactOnboardingBoundaries',
      'PassExactOnboardingRoles',
    ]);
    for (const statement of statements) {
      expect(statement.Resource).toEqual(expectedResources);
    }
    expect(
      statements.find(({ Sid }) => Sid === 'PassExactOnboardingRoles')
        ?.Condition,
    ).toMatchObject({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
  });

  it('contains provisioning actions for every Terraform service group', async () => {
    const template = await loadTemplate();
    const actions = new Set(
      policyStatements(template).flatMap((statement) =>
        typeof statement.Action === 'string'
          ? [statement.Action]
          : (statement.Action ?? []),
      ),
    );

    for (const action of [
      'sqs:CreateQueue',
      'logs:CreateLogGroup',
      'iam:CreateRole',
      'lambda:CreateFunction',
      'states:CreateStateMachine',
      'events:PutRule',
      'apigateway:POST',
      'cognito-idp:CreateUserPool',
      's3:CreateBucket',
      'cloudfront:CreateDistribution',
      'cloudwatch:PutMetricAlarm',
    ]) {
      expect(actions, `missing bootstrap action ${action}`).toContain(action);
    }
  });

  it('can remove only an HTTP API CORS child resource', async () => {
    const template = await loadTemplate();
    const statements = policyStatements(template);
    const corsDeletion = statements.find(
      ({ Sid }) => Sid === 'DeleteRegionalHttpApiCorsConfiguration',
    );
    const deleteStatements = statements.filter((statement) =>
      typeof statement.Action === 'string'
        ? statement.Action === 'apigateway:DELETE'
        : statement.Action?.includes('apigateway:DELETE'),
    );

    expect(deleteStatements).toEqual([corsDeletion]);
    expect(corsDeletion).toEqual({
      Sid: 'DeleteRegionalHttpApiCorsConfiguration',
      Effect: 'Allow',
      Action: 'apigateway:DELETE',
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*/cors',
      },
    });
  });

  it('grants the exact delivery APIs required to activate HTTP API access logs', async () => {
    const template = await loadTemplate();
    const statements = policyStatements(template);
    const delivery = statements.find(
      ({ Sid }) => Sid === 'ManageServiceLogDelivery',
    );
    const logGroups = statements.find(
      ({ Sid }) => Sid === 'ManageEnvironmentLogGroups',
    );

    expect(delivery?.Action).toEqual([
      'logs:CreateLogDelivery',
      'logs:DeleteLogDelivery',
      'logs:DescribeResourcePolicies',
      'logs:GetLogDelivery',
      'logs:ListLogDeliveries',
      'logs:PutResourcePolicy',
      'logs:UpdateLogDelivery',
    ]);
    expect(delivery?.Resource).toBe('*');
    expect(logGroups?.Action).toEqual(
      expect.arrayContaining(['logs:FilterLogEvents', 'logs:GetLogEvents']),
    );
    expect(logGroups?.Resource).not.toBe('*');
  });

  it('can discover only the managed CloudFront policies referenced by Terraform', async () => {
    const template = await loadTemplate();
    const statement = policyStatements(template).find(
      ({ Sid }) => Sid === 'ReadCloudFrontManagedPolicies',
    );

    expect(statement?.Action).toEqual([
      'cloudfront:GetCachePolicy',
      'cloudfront:GetCachePolicyConfig',
      'cloudfront:GetOriginRequestPolicy',
      'cloudfront:ListCachePolicies',
      'cloudfront:ListOriginRequestPolicies',
    ]);
    expect(statement?.Resource).toBe('*');
  });

  it('permits runtime PII detection without broader Comprehend access', async () => {
    const template = await loadTemplate();
    const boundary = template.Resources?.['LambdaRolePermissionsBoundary'];
    const policy = boundary?.Properties?.PolicyDocument;
    const comprehend = policy?.Statement?.find(
      ({ Sid }) => Sid === 'DetectIncidentPii',
    );

    expect(comprehend?.Action).toBe('comprehend:DetectPiiEntities');
    expect(comprehend?.Resource).toBe('*');
  });

  it('allows SES only as a boundary maximum while Terraform scopes the sender', async () => {
    const template = await loadTemplate();
    const boundary = template.Resources?.['LambdaRolePermissionsBoundary'];
    const sendEmail = boundary?.Properties?.PolicyDocument?.Statement?.find(
      ({ Sid }) => Sid === 'SendEmailThroughRoleScopedSesIdentity',
    );
    expect(sendEmail?.Action).toBe('ses:SendEmail');
    expect(sendEmail?.Resource).toEqual({
      'Fn::Sub':
        'arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:identity/*',
    });

    const review = await readFile(
      resolve('infrastructure/terraform/review.tf'),
      'utf8',
    );
    expect(review).toContain('sid     = "SendWorkspaceInvitationEmail"');
    expect(review).toContain('variable = "ses:FromAddress"');
    expect(review).toContain('values   = [var.invitation_email_from_address]');
  });

  it('limits runtime secret creation to tagged Slack installation credentials', async () => {
    const template = await loadTemplate();
    const boundary = template.Resources?.['LambdaRolePermissionsBoundary'];
    const statements = boundary?.Properties?.PolicyDocument?.Statement ?? [];
    const create = statements.find(
      ({ Sid }) => Sid === 'CreateTaggedSlackInstallationSecrets',
    );
    const write = statements.find(
      ({ Sid }) => Sid === 'WriteSlackInstallationSecretVersions',
    );

    expect(create?.Action).toEqual([
      'secretsmanager:CreateSecret',
      'secretsmanager:TagResource',
    ]);
    expect(create?.Resource).toEqual({
      'Fn::Sub':
        'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${ProjectName}/${Environment}/slack/installations/*',
    });
    expect(create?.Condition).toMatchObject({
      StringEquals: {
        'aws:RequestTag/onrecord:managed-by': 'onboarding',
        'aws:RequestTag/onrecord:credential-type': 'slack-installation',
      },
    });
    expect(write?.Action).toBe('secretsmanager:PutSecretValue');
    expect(JSON.stringify(write?.Resource)).toContain(
      '${ProjectName}/${Environment}/slack/installations/*',
    );
  });

  it('can read versions only for environment-scoped Lambda functions', async () => {
    const template = await loadTemplate();
    const statement = policyStatements(template).find(
      ({ Sid }) => Sid === 'ManageEnvironmentFunctions',
    );

    expect(statement?.Action).toContain('lambda:ListVersionsByFunction');
    expect(statement?.Resource).toEqual({
      'Fn::Sub':
        'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${ProjectName}-${Environment}-*',
    });
  });

  it('grants scoped AWS reads required by the deployment smoke test', async () => {
    const template = await loadTemplate();
    const statements = policyStatements(template);
    const functions = statements.find(
      ({ Sid }) => Sid === 'ManageEnvironmentFunctions',
    );
    const distribution = statements.find(
      ({ Sid }) => Sid === 'ManageTaggedReviewDistribution',
    );
    const smokeTest = await readFile(
      resolve('src/deployment/smoke-deployment.ts'),
      'utf8',
    );

    expect(smokeTest).toContain("'get-function-configuration'");
    expect(smokeTest).toContain("'create-invalidation'");
    expect(smokeTest).toContain("'invalidation-completed'");
    expect(functions?.Action).toContain('lambda:GetFunctionConfiguration');
    expect(functions?.Resource).toEqual({
      'Fn::Sub':
        'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${ProjectName}-${Environment}-*',
    });
    expect(distribution?.Action).toEqual(
      expect.arrayContaining([
        'cloudfront:CreateInvalidation',
        'cloudfront:GetInvalidation',
      ]),
    );
    expect(distribution?.Resource).toEqual({
      'Fn::Sub':
        'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/*',
    });
  });

  it('grants the provider read access required to manage the environment workflow', async () => {
    const template = await loadTemplate();
    const statements = policyStatements(template);
    const management = statements.find(
      ({ Sid }) => Sid === 'ManageEnvironmentStateMachine',
    );
    const validation = statements.find(
      ({ Sid }) => Sid === 'ValidateStateMachineDefinition',
    );

    expect(management?.Action).toContain('states:ListStateMachineVersions');
    expect(management?.Action).not.toContain('states:DeleteStateMachine');
    expect(management?.Resource).toEqual({
      'Fn::Sub':
        'arn:${AWS::Partition}:states:${AWS::Region}:${AWS::AccountId}:stateMachine:${ProjectName}-${Environment}-*',
    });
    expect(validation).toMatchObject({
      Action: 'states:ValidateStateMachineDefinition',
      Resource: '*',
    });
  });

  it('attaches the permissions boundary to every Terraform-created role', async () => {
    const terraform = `${await readFile(
      resolve('infrastructure/terraform/main.tf'),
      'utf8',
    )}\n${await readFile(
      resolve('infrastructure/terraform/review.tf'),
      'utf8',
    )}\n${await readFile(
      resolve('infrastructure/terraform/onboarding.tf'),
      'utf8',
    )}`;
    const roleBodies = [
      ...terraform.matchAll(
        /resource "aws_iam_role" "[^"]+" \{(?<body>[\s\S]*?)\n\}/gu,
      ),
    ].map((match) => match.groups?.['body'] ?? '');

    expect(roleBodies).toHaveLength(12);
    expect(
      roleBodies.filter((body) =>
        body.includes(
          'permissions_boundary = var.lambda_role_permissions_boundary_arn',
        ),
      ),
    ).toHaveLength(11);
    expect(
      roleBodies.filter((body) =>
        body.includes(
          'permissions_boundary = var.workflow_role_permissions_boundary_arn',
        ),
      ),
    ).toHaveLength(1);
  });
});
