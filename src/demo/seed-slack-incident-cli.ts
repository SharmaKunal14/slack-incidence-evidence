import { z } from 'zod';
import {
  previewSlackIncident,
  seedSlackIncident,
} from './slack-incident-seeder.js';

const environmentSchema = z.object({
  SLACK_DEMO_WORKSPACE_ID: z.string().regex(/^T[A-Z0-9]{1,63}$/),
  SLACK_DEMO_MAYA_TOKEN: z.string().trim().min(1),
  SLACK_DEMO_ARJUN_TOKEN: z.string().trim().min(1),
});

interface CliOptions {
  readonly execute: boolean;
  readonly channelSuffix: string;
  readonly delayMs: number;
  readonly onRecordBotUserId?: string;
}

const options = parseArguments(process.argv.slice(2));
if (!options.execute) {
  process.stdout.write(`${previewSlackIncident(options.channelSuffix)}\n`);
} else {
  const environment = environmentSchema.parse(process.env);
  const result = await seedSlackIncident(
    {
      workspaceId: environment.SLACK_DEMO_WORKSPACE_ID,
      mayaToken: environment.SLACK_DEMO_MAYA_TOKEN,
      arjunToken: environment.SLACK_DEMO_ARJUN_TOKEN,
      channelSuffix: options.channelSuffix,
      delayMs: options.delayMs,
      ...(options.onRecordBotUserId === undefined
        ? {}
        : { onRecordBotUserId: options.onRecordBotUserId }),
    },
    { onProgress: (message) => process.stdout.write(`${message}\n`) },
  );
  process.stdout.write(`\nScenario created successfully\n\n`);
  process.stdout.write(`Workspace: ${result.workspaceId}\n`);
  process.stdout.write(
    `Actors: ${result.actors.maya.user} (${result.actors.maya.userId}), ${result.actors.arjun.user} (${result.actors.arjun.userId})\n`,
  );
  process.stdout.write(
    `Primary channel: #${result.channels['incident-checkout'].name}\n`,
  );
  process.stdout.write(
    `Additional channels: #${result.channels['security-alerts'].name}, #${result.channels.deployments.name}\n`,
  );
  process.stdout.write(`Messages: ${result.messageCount}\n`);
  process.stdout.write(`\nUse these OnRecord anchor threads:\n`);
  for (const anchor of result.anchors) {
    process.stdout.write(
      `- ${anchor.id} (#${anchor.channel}): ${anchor.permalink}\n`,
    );
  }
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  let execute = false;
  let channelSuffix = '';
  let delayMs = 1_100;
  let onRecordBotUserId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--execute') {
      execute = true;
      continue;
    }
    if (argument === '--channel-suffix') {
      channelSuffix = requireValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === '--delay-ms') {
      delayMs = Number.parseInt(
        requireValue(arguments_, ++index, argument),
        10,
      );
      if (!Number.isInteger(delayMs) || delayMs < 1_000 || delayMs > 60_000) {
        throw new Error('--delay-ms must be an integer from 1000 to 60000');
      }
      continue;
    }
    if (argument === '--onrecord-bot-user-id') {
      onRecordBotUserId = requireValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === '--help') {
      process.stdout.write(
        'Usage: npm run demo:slack -- [--execute] [--channel-suffix NAME] [--delay-ms 1100] [--onrecord-bot-user-id U123]\n',
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }
  return {
    execute,
    channelSuffix,
    delayMs,
    ...(onRecordBotUserId === undefined ? {} : { onRecordBotUserId }),
  };
}

function requireValue(
  arguments_: readonly string[],
  index: number,
  flag: string,
): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
