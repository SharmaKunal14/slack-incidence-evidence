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
    const roleManagement = template.Resources?.['RuntimeRoleManagementPolicy'];
    const policy = JSON.stringify(roleManagement?.Properties?.PolicyDocument);

    expect(policy).not.toContain('github-deploy');
    expect(policy).not.toContain('role/${ProjectName}-${Environment}-*');
  });

  it('requires the boundary and deployment tags when creating roles', async () => {
    const template = await loadTemplate();
    const createRoles = policyStatements(template).filter(
      (statement) => statement.Action === 'iam:CreateRole',
    );

    expect(createRoles).toHaveLength(2);
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

  it('attaches the permissions boundary to every Terraform-created role', async () => {
    const terraform = `${await readFile(
      resolve('infrastructure/terraform/main.tf'),
      'utf8',
    )}\n${await readFile(resolve('infrastructure/terraform/review.tf'), 'utf8')}`;
    const roleBodies = [
      ...terraform.matchAll(
        /resource "aws_iam_role" "[^"]+" \{(?<body>[\s\S]*?)\n\}/gu,
      ),
    ].map((match) => match.groups?.['body'] ?? '');

    expect(roleBodies).toHaveLength(9);
    expect(
      roleBodies.filter((body) =>
        body.includes(
          'permissions_boundary = var.lambda_role_permissions_boundary_arn',
        ),
      ),
    ).toHaveLength(8);
    expect(
      roleBodies.filter((body) =>
        body.includes(
          'permissions_boundary = var.workflow_role_permissions_boundary_arn',
        ),
      ),
    ).toHaveLength(1);
  });
});
