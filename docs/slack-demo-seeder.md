# Synthetic Slack incident seeder

The demo seeder creates a fictional cybersecurity outage in three public Slack
channels. It posts 31 messages and their thread relationships as two genuine
Slack users:

- Maya Chen, incident commander and platform engineer
- Arjun Rao, security engineer

The scenario is synthetic. It must not be described as a real customer incident.
It deliberately includes an initially plausible but rejected deployment theory,
a bounded security conclusion, and an unresolved question about how an SSO
session was acquired.

## Safety model

Use a disposable demonstration workspace containing no real company or customer
data. The command is a dry run unless `--execute` is supplied. Before creating
anything, it verifies that both user tokens resolve to different users in the
exact workspace configured by `SLACK_DEMO_WORKSPACE_ID`.

The command refuses to reuse existing channel names because another run would
silently duplicate evidence. Supply a unique `--channel-suffix` for subsequent
runs. A partially completed run is not rolled back automatically; Slack does not
offer an atomic multi-message transaction.

## Create the least-privilege seeder app

Do not add demo-seeding permissions to the production OnRecord app. Create a
separate Slack app in the disposable workspace from
`config/slack-demo-seeder-manifest.yaml`.

The app requests these user scopes:

- `channels:write` to create public channels
- `channels:write.invites` to add the second user
- `chat:write` to post as the authorizing user

Both Slack accounts must authorize this seeder app. Slack's OAuth V2 response
places the user token in `authed_user.access_token`; it commonly begins with
`xoxp-`. If token rotation is enabled later, also store and rotate the associated
refresh token. This demo manifest intentionally leaves rotation disabled for a
short-lived disposable environment.

One practical way to perform the two OAuth grants is an OAuth 2.0 client such as
Postman:

1. Add the client's callback URL to the app's **OAuth & Permissions → Redirect
   URLs**.
2. Use `https://slack.com/oauth/v2/authorize` as the authorization URL and
   `https://slack.com/api/oauth.v2.access` as the access-token URL.
3. Set the user scopes to
   `channels:write,channels:write.invites,chat:write`.
4. Authorize once while signed in as the account representing Maya and copy
   `authed_user.access_token`.
5. Start a fresh browser session, authorize as the account representing Arjun,
   and copy its `authed_user.access_token`.

The two users' actual Slack profile names do not have to be Maya and Arjun. Those
are scenario roles; the seeder prints the real token owners before reporting
success.

## Configure the environment

Copy `.env.example` to `.env` if it does not already exist, then set:

```dotenv
SLACK_DEMO_WORKSPACE_ID=T0123456789
SLACK_DEMO_MAYA_TOKEN=xoxp-first-user-token
SLACK_DEMO_ARJUN_TOKEN=xoxp-second-user-token
```

Find the workspace ID in Slack's workspace details or by calling `auth.test`
with either token. Never commit `.env`, paste these tokens into Slack, or expose
them in a screen recording.

## Preview and execute

Load `.env` into the current shell and preview the plan. Preview mode makes no
network calls and does not require valid tokens:

```bash
set -a
source .env
set +a
npm run demo:slack
```

Create the channels and messages:

```bash
npm run demo:slack -- --execute
```

For OnRecord to collect these public channels, its bot must be a channel member.
Copy the OnRecord app's member ID from its Slack profile and let the seeder invite
it automatically:

```bash
npm run demo:slack -- --execute --onrecord-bot-user-id U0123456789
```

If you omit that option, run `/invite @OnRecord` once in each of the three
created channels before starting incident reconstruction.

Slack generally limits message posting to roughly one message per second per
channel. The seeder therefore waits 1.1 seconds between messages and normally
takes about 35 seconds. To use a slower interval:

```bash
npm run demo:slack -- --execute --delay-ms 1500
```

For another run, use new channel names:

```bash
npm run demo:slack -- --execute --channel-suffix buildweek2
```

This creates `#incident-checkout-buildweek2`,
`#security-alerts-buildweek2`, and `#deployments-buildweek2`.

After completion, the command prints the primary channel, additional channels,
and five anchor-thread permalinks. OnRecord now discovers these in-window roots
automatically, so the additional-thread field may be left empty for the normal
demo. The printed links remain useful for verifying discovery or explicitly
including a root that falls outside a future selected window.

## Known limitations

- Slack API messages cannot be backdated. Each message includes a clearly marked
  simulated UTC timestamp that OnRecord should preserve as reported event time;
  the Slack permalink timestamp remains the evidence-capture time.
- Channel creation and message posting are not atomic. If a call fails midway,
  retain the partial run for debugging or start again with a unique suffix.
- These are user tokens and carry the permissions of their owners. Revoke the
  seeder grants or uninstall the seeder app after the demo.
- The scenario tests evidence reconstruction, contradictions, uncertainty, and
  thread collection. It does not prove production security or semantic accuracy
  on real incidents.
