import { z } from 'zod';
import {
  reconcileRevisionStatements,
  type RevisionStatementView,
} from './revision-view.js';
import { safeSourceUrl } from './safe-source-url.js';

const classificationValues = [
  'directly_observed',
  'corroborated',
  'participant_assertion',
  'hypothesis',
  'correlated_inference',
  'disputed',
  'unknown',
  'human_confirmed',
] as const;

const configurationSchema = z
  .object({
    apiBaseUrl: z.url(),
    cognitoBaseUrl: z.url(),
    cognitoClientId: z.string().min(1).max(128),
    redirectUri: z.url(),
  })
  .strict();

const inboxItemSchema = z
  .object({
    incidentId: z.uuid(),
    title: z.string(),
    severity: z.string(),
    status: z.enum(['NEEDS_REVIEW', 'APPROVED']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    incidentVersion: z.number().int().nonnegative(),
    reportDraftId: z.uuid(),
    claimCount: z.number().int().nonnegative(),
    timelineEventCount: z.number().int().nonnegative(),
    openQuestionCount: z.number().int().nonnegative(),
    contradictionCount: z.number().int().nonnegative(),
    latestRevisionId: z.uuid().nullable(),
    latestRevisionNumber: z.number().int().positive().nullable(),
    latestRevisionStatus: z.enum(['DRAFT', 'APPROVED']).nullable(),
  })
  .strict();

const inboxSchema = z
  .object({
    items: z.array(inboxItemSchema).max(50),
    nextCursor: z.string().max(1024).nullable(),
  })
  .strict();

const statementSchema = z
  .object({
    id: z.string(),
    sectionType: z.string(),
    position: z.number().int().nonnegative(),
    statementType: z.enum(['claim', 'timeline']),
    text: z.string(),
    classification: z.enum(classificationValues),
    claimIds: z.array(z.string()),
    timelineEventIds: z.array(z.string()),
  })
  .strict();

const revisionSummarySchema = z
  .object({
    id: z.uuid(),
    revisionNumber: z.number().int().positive(),
    status: z.enum(['DRAFT', 'APPROVED']),
    createdAt: z.iso.datetime(),
    statementCount: z.number().int().positive(),
    acknowledgedContradictions: z.boolean(),
    acknowledgedOpenQuestions: z.boolean(),
  })
  .strict();

const revisionStatementSchema = z
  .object({
    originalStatementId: z.string(),
    sectionType: z.string(),
    position: z.number().int().nonnegative(),
    decision: z.enum(['KEEP', 'EDIT', 'EXCLUDE']),
    text: z.string().nullable(),
    classification: z.enum(classificationValues).nullable(),
  })
  .strict();

const bundleSchema = z
  .object({
    incident: z
      .object({
        id: z.uuid(),
        title: z.string(),
        severity: z.string(),
        status: z.enum(['NEEDS_REVIEW', 'APPROVED']),
        version: z.number().int().nonnegative(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    reportDraft: z
      .object({
        id: z.uuid(),
        draftVersion: z.number().int().positive(),
        renderedMarkdown: z.string(),
      })
      .strict(),
    sections: z.array(
      z
        .object({
          sectionType: z.string(),
          position: z.number().int().nonnegative(),
          statements: z.array(statementSchema),
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          id: z.string(),
          statement: z.string(),
          classification: z.enum(classificationValues),
          reviewStatus: z.string(),
          supportingEvidenceIds: z.array(z.string()),
          contradictingEvidenceIds: z.array(z.string()),
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          id: z.string(),
          occurredAt: z.iso.datetime(),
          summary: z.string(),
          classification: z.enum(classificationValues),
          evidenceIds: z.array(z.string()),
        })
        .strict(),
    ),
    evidence: z.array(
      z
        .object({
          id: z.string(),
          sourceType: z.string(),
          occurredAt: z.iso.datetime(),
          authorReference: z.string().nullable(),
          content: z.string(),
          contentTruncated: z.boolean(),
          sourceUri: z.string().nullable(),
        })
        .strict(),
    ),
    openQuestions: z.array(
      z.object({ id: z.string(), question: z.string() }).strict(),
    ),
    revisions: z.array(revisionSummarySchema).max(50),
    latestRevision: revisionSummarySchema
      .extend({ statements: z.array(revisionStatementSchema).max(300) })
      .strict()
      .nullable(),
  })
  .strict();

const revisionResponseSchema = z
  .object({
    revision: z
      .object({
        id: z.uuid(),
        revisionNumber: z.number().int().positive(),
        status: z.enum(['DRAFT', 'APPROVED']),
      })
      .passthrough(),
  })
  .strict();

type Bundle = z.infer<typeof bundleSchema>;
type Statement = z.infer<typeof statementSchema>;
type Classification = (typeof classificationValues)[number];

declare global {
  interface Window {
    __INCIDENT_REVIEW_CONFIG__?: unknown;
  }
}

const app = requireElement('app');

void bootstrap().catch(() => {
  renderFatal('The review console could not be initialized.');
});

async function bootstrap(): Promise<void> {
  const configuration = configurationSchema.parse(
    window.__INCIDENT_REVIEW_CONFIG__,
  );
  await completeAuthorizationCallback(configuration);
  window.addEventListener('hashchange', () => {
    void route(configuration);
  });
  await route(configuration);
}

async function route(
  configuration: z.infer<typeof configurationSchema>,
): Promise<void> {
  const token = sessionStorage.getItem('review_access_token');
  if (token === null) {
    renderSignIn(configuration);
    return;
  }
  const match = /^#\/incidents\/([0-9a-f-]{36})$/iu.exec(location.hash);
  if (match?.[1] !== undefined) {
    await renderIncident(configuration, token, match[1]);
  } else {
    await renderInbox(configuration, token);
  }
}

function renderSignIn(
  configuration: z.infer<typeof configurationSchema>,
): void {
  const shell = element('section', 'shell');
  const panel = element('div', 'panel stack');
  panel.append(
    element('h1', undefined, 'Incident Evidence Review'),
    element(
      'p',
      'muted',
      'Authenticate to review source-linked postmortem drafts. Incident IDs do not grant access.',
    ),
  );
  const button = element('button', undefined, 'Sign in');
  button.addEventListener('click', () => {
    void startAuthorization(configuration);
  });
  panel.append(button);
  shell.append(panel);
  app.replaceChildren(shell);
}

async function renderInbox(
  configuration: z.infer<typeof configurationSchema>,
  token: string,
): Promise<void> {
  renderLoading();
  try {
    const page = inboxSchema.parse(
      await apiRequest(configuration, token, '/review/incidents?limit=50'),
    );
    const shell = element('section', 'shell');
    shell.append(topbar(configuration, 'Review inbox'));
    if (page.items.length === 0) {
      shell.append(
        element('p', 'empty', 'No incidents currently require review.'),
      );
    }
    for (const incident of page.items) {
      const card = element('article', 'card');
      const title = element('h2', undefined, incident.title);
      const metadata = element('div', 'meta-row muted');
      metadata.append(
        badge(incident.status, incident.status === 'APPROVED' ? 'success' : ''),
        document.createTextNode(incident.severity),
        document.createTextNode(`${incident.claimCount} claims`),
        document.createTextNode(
          `${incident.contradictionCount} contradictions`,
        ),
        document.createTextNode(`${incident.openQuestionCount} open questions`),
      );
      const open = element('button', undefined, 'Open review');
      open.addEventListener('click', () => {
        location.hash = `#/incidents/${incident.incidentId}`;
      });
      card.append(title, metadata, open);
      shell.append(card);
    }
    app.replaceChildren(shell);
  } catch (error) {
    handleRequestFailure(configuration, error);
  }
}

async function renderIncident(
  configuration: z.infer<typeof configurationSchema>,
  token: string,
  incidentId: string,
): Promise<void> {
  renderLoading();
  try {
    const bundle = bundleSchema.parse(
      await apiRequest(
        configuration,
        token,
        `/review/incidents/${encodeURIComponent(incidentId)}`,
      ),
    );
    const shell = element('section', 'shell');
    shell.append(topbar(configuration, bundle.incident.title, true));
    const status = element('div', 'meta-row');
    status.append(
      badge(
        bundle.incident.status,
        bundle.incident.status === 'APPROVED' ? 'success' : 'warning',
      ),
      badge(bundle.incident.severity),
      element(
        'span',
        'muted',
        bundle.latestRevision === null
          ? `Viewing original AI draft ${bundle.reportDraft.draftVersion} · incident version ${bundle.incident.version}`
          : `Viewing human revision ${bundle.latestRevision.revisionNumber} (${humanize(bundle.latestRevision.status)}) · based on AI draft ${bundle.reportDraft.draftVersion} · incident version ${bundle.incident.version}`,
      ),
    );
    shell.append(status);

    const layout = element('div', 'grid');
    const reportColumn = element('div', 'stack');
    const evidenceColumn = element('aside', 'stack');
    const controls = new Map<
      string,
      {
        decision: HTMLSelectElement;
        text: HTMLTextAreaElement;
        classification: HTMLSelectElement;
      }
    >();
    const sourceStatements = bundle.sections.flatMap(
      (section) => section.statements,
    );
    const statementViews = reconcileRevisionStatements(
      sourceStatements,
      bundle.latestRevision?.statements ?? null,
    );
    const editable = bundle.incident.status === 'NEEDS_REVIEW';
    for (const section of bundle.sections) {
      const sectionElement = element('section', 'section stack');
      sectionElement.append(
        element('h2', undefined, humanize(section.sectionType)),
      );
      for (const statement of section.statements) {
        const view = statementViews.get(statement.id);
        if (view === undefined) {
          throw new Error('Report statement has no display decision');
        }
        sectionElement.append(
          renderStatement(statement, view, editable, controls),
        );
      }
      reportColumn.append(sectionElement);
    }

    renderEvidencePanels(bundle, evidenceColumn);
    layout.append(reportColumn, evidenceColumn);
    shell.append(layout);
    if (bundle.incident.status === 'NEEDS_REVIEW') {
      shell.append(reviewActions(configuration, token, bundle, controls));
    }
    app.replaceChildren(shell);
  } catch (error) {
    handleRequestFailure(configuration, error);
  }
}

function renderStatement(
  statement: Statement,
  view: RevisionStatementView,
  editable: boolean,
  controls: Map<
    string,
    {
      decision: HTMLSelectElement;
      text: HTMLTextAreaElement;
      classification: HTMLSelectElement;
    }
  >,
): HTMLElement {
  const card = element('article', 'statement stack');
  card.id = `statement-${statement.id}`;
  card.append(badge(view.classification));
  const decision = document.createElement('select');
  for (const value of ['KEEP', 'EDIT', 'EXCLUDE'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = humanize(value);
    option.selected = value === view.decision;
    decision.append(option);
  }
  const text = document.createElement('textarea');
  text.value = view.text;
  text.maxLength = 4_000;
  const classification = document.createElement('select');
  for (const value of classificationValues) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = humanize(value);
    option.selected = value === view.classification;
    classification.append(option);
  }
  const updateControlState = (): void => {
    const editing = editable && decision.value === 'EDIT';
    const excluded = decision.value === 'EXCLUDE';
    decision.disabled = !editable;
    text.disabled = !editing;
    classification.disabled = !editing;
    card.classList.toggle('excluded', excluded);
  };
  decision.addEventListener('change', updateControlState);
  updateControlState();
  const links = element('div', 'source-links');
  for (const sourceId of [
    ...statement.claimIds,
    ...statement.timelineEventIds,
  ]) {
    const button = element('button', 'secondary', `Source ${sourceId}`);
    button.type = 'button';
    button.addEventListener('click', () => highlightSource(sourceId));
    links.append(button);
  }
  card.append(decision, text, classification, links);
  controls.set(statement.id, { decision, text, classification });
  return card;
}

function renderEvidencePanels(bundle: Bundle, target: HTMLElement): void {
  const questions = element('section', 'panel stack');
  questions.append(element('h2', undefined, 'Open questions'));
  if (bundle.openQuestions.length === 0) {
    questions.append(
      element('p', 'muted', 'No open questions were extracted.'),
    );
  } else {
    for (const question of bundle.openQuestions) {
      questions.append(element('p', undefined, question.question));
    }
  }
  target.append(questions);

  const claims = element('section', 'panel stack');
  claims.append(element('h2', undefined, 'Claims'));
  for (const claim of bundle.claims) {
    const card = element('article', 'claim stack');
    card.id = `source-${claim.id}`;
    card.append(
      badge(
        claim.classification,
        claim.contradictingEvidenceIds.length > 0 ? 'warning' : '',
      ),
      element('p', undefined, claim.statement),
    );
    const links = element('div', 'source-links');
    for (const evidenceId of [
      ...claim.supportingEvidenceIds,
      ...claim.contradictingEvidenceIds,
    ]) {
      const button = element('button', 'secondary', `Evidence ${evidenceId}`);
      button.type = 'button';
      button.addEventListener('click', () => highlightSource(evidenceId));
      links.append(button);
    }
    card.append(links);
    claims.append(card);
  }
  target.append(claims);

  const timeline = element('section', 'panel stack');
  timeline.append(element('h2', undefined, 'Timeline'));
  for (const event of bundle.timeline) {
    const card = element('article', 'claim stack');
    card.id = `source-${event.id}`;
    card.append(
      badge(event.classification),
      element('time', 'muted', new Date(event.occurredAt).toLocaleString()),
      element('p', undefined, event.summary),
    );
    timeline.append(card);
  }
  target.append(timeline);

  const evidence = element('section', 'panel stack');
  evidence.append(element('h2', undefined, 'Source evidence'));
  for (const source of bundle.evidence) {
    const card = element('article', 'evidence');
    card.id = `source-${source.id}`;
    const metadata = element('div', 'meta-row muted');
    metadata.append(
      document.createTextNode(source.sourceType),
      document.createTextNode(new Date(source.occurredAt).toLocaleString()),
    );
    const content = document.createElement('pre');
    content.textContent = source.content;
    card.append(metadata, content);
    const sourceUrl = safeSourceUrl(source.sourceUri);
    if (sourceUrl !== null) {
      const link = document.createElement('a');
      link.href = sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open original source';
      card.append(link);
    }
    if (source.contentTruncated) {
      card.append(
        element(
          'p',
          'muted',
          'Displayed content was truncated by the API limit.',
        ),
      );
    }
    evidence.append(card);
  }
  target.append(evidence);
}

function reviewActions(
  configuration: z.infer<typeof configurationSchema>,
  token: string,
  bundle: Bundle,
  controls: Map<
    string,
    {
      decision: HTMLSelectElement;
      text: HTMLTextAreaElement;
      classification: HTMLSelectElement;
    }
  >,
): HTMLElement {
  const panel = element('section', 'panel stack');
  panel.append(element('h2', undefined, 'Human review decision'));
  const contradictionAcknowledgement = labelledCheckbox(
    'I reviewed and acknowledge material contradictions.',
  );
  const questionAcknowledgement = labelledCheckbox(
    'I reviewed and acknowledge the open questions.',
  );
  const acknowledgements = element('div', 'acknowledgements');
  contradictionAcknowledgement.input.checked =
    bundle.latestRevision?.acknowledgedContradictions ?? false;
  questionAcknowledgement.input.checked =
    bundle.latestRevision?.acknowledgedOpenQuestions ?? false;
  acknowledgements.append(
    contradictionAcknowledgement.label,
    questionAcknowledgement.label,
  );
  panel.append(acknowledgements);
  const notice = element('p', 'notice');
  notice.hidden = true;
  panel.append(notice);
  const actions = element('div', 'actions');
  const save = element('button', undefined, 'Save immutable revision');
  const approve = element('button', 'danger', 'Approve latest revision');
  const displayedDraft =
    bundle.latestRevision?.status === 'DRAFT'
      ? bundle.latestRevision
      : undefined;
  approve.disabled = displayedDraft === undefined;
  save.addEventListener('click', () => {
    void (async () => {
      setBusy([save, approve], true);
      try {
        const decisions = [...controls.entries()].map(
          ([statementId, control]) => {
            if (control.decision.value === 'EDIT') {
              return {
                statementId,
                decision: 'EDIT',
                text: control.text.value,
                classification: control.classification.value as Classification,
              };
            }
            return {
              statementId,
              decision:
                control.decision.value === 'EXCLUDE' ? 'EXCLUDE' : 'KEEP',
            };
          },
        );
        const result = revisionResponseSchema.parse(
          await apiRequest(
            configuration,
            token,
            `/review/incidents/${encodeURIComponent(bundle.incident.id)}/revisions`,
            {
              method: 'POST',
              body: JSON.stringify({
                incidentId: bundle.incident.id,
                reportDraftId: bundle.reportDraft.id,
                expectedIncidentVersion: bundle.incident.version,
                clientRequestId: crypto.randomUUID(),
                acknowledgedContradictions:
                  contradictionAcknowledgement.input.checked,
                acknowledgedOpenQuestions:
                  questionAcknowledgement.input.checked,
                decisions,
              }),
            },
          ),
        );
        notice.textContent = `Revision ${result.revision.revisionNumber} saved. Reloading review…`;
        notice.hidden = false;
        await renderIncident(configuration, token, bundle.incident.id);
      } catch (error) {
        notice.textContent = userFacingError(error);
        notice.className = 'error';
        notice.hidden = false;
        setBusy([save, approve], false);
      }
    })();
  });
  approve.addEventListener('click', () => {
    if (displayedDraft === undefined) {
      return;
    }
    void (async () => {
      setBusy([save, approve], true);
      try {
        await apiRequest(
          configuration,
          token,
          `/review/incidents/${encodeURIComponent(bundle.incident.id)}/revisions/${encodeURIComponent(displayedDraft.id)}/approve`,
          {
            method: 'POST',
            body: JSON.stringify({
              incidentId: bundle.incident.id,
              revisionId: displayedDraft.id,
              expectedIncidentVersion: bundle.incident.version,
              clientRequestId: crypto.randomUUID(),
            }),
          },
        );
        await renderIncident(configuration, token, bundle.incident.id);
      } catch (error) {
        notice.textContent = userFacingError(error);
        notice.className = 'error';
        notice.hidden = false;
        setBusy([save, approve], false);
      }
    })();
  });
  actions.append(save, approve);
  panel.append(actions);
  return panel;
}

function topbar(
  configuration: z.infer<typeof configurationSchema>,
  title: string,
  showBack = false,
): HTMLElement {
  const header = element('header', 'topbar');
  const left = element('div', 'actions');
  if (showBack) {
    const back = element('button', 'secondary', 'Back');
    back.addEventListener('click', () => {
      location.hash = '#/';
    });
    left.append(back);
  }
  left.append(element('h1', undefined, title));
  const logout = element('button', 'secondary', 'Sign out');
  logout.addEventListener('click', () => signOut(configuration));
  header.append(left, logout);
  return header;
}

async function apiRequest(
  configuration: z.infer<typeof configurationSchema>,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(new URL(path, configuration.apiBaseUrl), {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
  });
  if (response.status === 401) {
    sessionStorage.removeItem('review_access_token');
    throw new AuthenticationExpiredError();
  }
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const body = await response.text();
  if (body.length > 5_000_000) {
    throw new Error('API response exceeded the browser limit');
  }
  return JSON.parse(body) as unknown;
}

async function startAuthorization(
  configuration: z.infer<typeof configurationSchema>,
): Promise<void> {
  const verifier = randomValue(64);
  const state = randomValue(32);
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  sessionStorage.setItem('oauth_verifier', verifier);
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('post_login_hash', location.hash || '#/');
  const authorize = new URL('/oauth2/authorize', configuration.cognitoBaseUrl);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: configuration.cognitoClientId,
    redirect_uri: configuration.redirectUri,
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  location.assign(authorize);
}

async function completeAuthorizationCallback(
  configuration: z.infer<typeof configurationSchema>,
): Promise<void> {
  const parameters = new URLSearchParams(location.search);
  const code = parameters.get('code');
  if (code === null) {
    return;
  }
  const state = parameters.get('state');
  const expectedState = sessionStorage.getItem('oauth_state');
  const verifier = sessionStorage.getItem('oauth_verifier');
  if (
    state === null ||
    expectedState === null ||
    verifier === null ||
    state !== expectedState
  ) {
    throw new Error('OAuth callback state validation failed');
  }
  const tokenUrl = new URL('/oauth2/token', configuration.cognitoBaseUrl);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: configuration.cognitoClientId,
      code,
      redirect_uri: configuration.redirectUri,
      code_verifier: verifier,
    }),
  });
  const tokenBody = await response.text();
  if (!response.ok || tokenBody.length > 100_000) {
    throw new Error('OAuth token exchange failed');
  }
  const token = z
    .object({
      access_token: z.string().min(1).max(16_384),
      token_type: z.literal('Bearer'),
      expires_in: z.number().int().positive(),
    })
    .passthrough()
    .parse(JSON.parse(tokenBody) as unknown);
  sessionStorage.setItem('review_access_token', token.access_token);
  const postLoginHash = sessionStorage.getItem('post_login_hash') ?? '#/';
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_verifier');
  sessionStorage.removeItem('post_login_hash');
  history.replaceState({}, '', `${location.pathname}${postLoginHash}`);
}

function signOut(configuration: z.infer<typeof configurationSchema>): void {
  sessionStorage.clear();
  const logout = new URL('/logout', configuration.cognitoBaseUrl);
  logout.search = new URLSearchParams({
    client_id: configuration.cognitoClientId,
    logout_uri: configuration.redirectUri,
  }).toString();
  location.assign(logout);
}

function handleRequestFailure(
  configuration: z.infer<typeof configurationSchema>,
  error: unknown,
): void {
  if (error instanceof AuthenticationExpiredError) {
    renderSignIn(configuration);
    return;
  }
  renderFatal(userFacingError(error));
}

function userFacingError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return 'The review request was invalid. Check every decision and acknowledgement.';
      case 403:
        return 'Your account is not an active reviewer for this workspace.';
      case 404:
        return 'The incident was not found or is not available to your account.';
      case 409:
        return 'The incident changed while you were reviewing it. Reload before continuing.';
      default:
        return 'The review service is temporarily unavailable.';
    }
  }
  return 'The review operation could not be completed.';
}

function highlightSource(id: string): void {
  const source = document.getElementById(`source-${id}`);
  if (source === null) {
    return;
  }
  source.classList.add('highlight');
  source.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => source.classList.remove('highlight'), 2_000);
}

function labelledCheckbox(text: string): {
  readonly label: HTMLLabelElement;
  readonly input: HTMLInputElement;
} {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  label.append(input, document.createTextNode(` ${text}`));
  return { label, input };
}

function badge(text: string, extraClass = ''): HTMLElement {
  return element('span', `badge ${extraClass}`.trim(), humanize(text));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error('Required application element was not found');
  }
  return node;
}

function renderLoading(): void {
  app.replaceChildren(element('p', 'loading', 'Loading…'));
}

function renderFatal(message: string): void {
  const shell = element('section', 'shell');
  shell.append(element('p', 'error', message));
  app.replaceChildren(shell);
}

function setBusy(buttons: readonly HTMLButtonElement[], busy: boolean): void {
  for (const button of buttons) {
    button.disabled = busy;
  }
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./u, (letter) => letter.toUpperCase());
}

function randomValue(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

class ApiError extends Error {
  public constructor(public readonly status: number) {
    super('Review API request failed');
    this.name = 'ApiError';
  }
}

class AuthenticationExpiredError extends Error {}
