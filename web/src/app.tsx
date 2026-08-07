import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpenText,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Compass,
  ExternalLink,
  FileCheck2,
  FileText,
  History,
  Inbox,
  Link2,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  PencilLine,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Unplug,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  Component,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  ApiError,
  apiRequest,
  AuthenticationExpiredError,
  signOut,
  startAuthorization,
} from './auth.js';
import {
  bundleSchema,
  classificationValues,
  inboxSchema,
  revisionDetailResponseSchema,
  revisionResponseSchema,
  slackDisconnectionResponseSchema,
  slackOnboardingStatusSchema,
  type Bundle,
  type Classification,
  type Configuration,
  type InboxItem,
  type RevisionDetail,
  type Statement,
} from './contracts.js';
import {
  consumeSlackOnboardingCallbackResult,
  requestSlackAuthorization,
  type SlackOnboardingCallbackResult,
} from './slack-onboarding.js';
import {
  reconcileRevisionQuestionAnswers,
  reconcileRevisionStatements,
  requiresPreservedRevisionFetch,
} from './revision-view.js';
import { safeSourceUrl } from './safe-source-url.js';
import {
  clearEvidenceFocus,
  focusEvidenceSource,
  type EvidenceFocus,
} from './evidence-focus.js';
import { GuidedTour, hasCompletedDemoTour } from './guided-tour.js';

type InboxFilter = 'ALL' | 'NEEDS_REVIEW' | 'APPROVED';
type EvidenceTab = 'questions' | 'claims' | 'timeline' | 'evidence';
type ReviewDecision = 'KEEP' | 'EDIT' | 'EXCLUDE';
type Experience = 'production' | 'demo';

export type ReviewApiClient = (
  configuration: Configuration,
  token: string,
  path: string,
  init?: RequestInit,
) => Promise<unknown>;

export interface StatementState {
  readonly decision: ReviewDecision;
  readonly text: string;
  readonly classification: Classification;
}

interface AdditionalStatementState {
  readonly clientStatementId: string;
  readonly sectionType: string;
  readonly text: string;
  readonly classification: Classification;
  readonly claimIds: readonly string[];
  readonly timelineEventIds: readonly string[];
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

class ApplicationErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override render(): ReactNode {
    return this.state.failed ? <StartupFailure /> : this.props.children;
  }
}

export function IncidentReviewApplication({
  configuration,
  apiClient = apiRequest,
}: {
  readonly configuration: Configuration;
  readonly apiClient?: ReviewApiClient;
}): ReactNode {
  const [slackCallbackResult] = useState(() =>
    consumeSlackOnboardingCallbackResult(),
  );
  const [token, setToken] = useState<string | null>(() =>
    sessionStorage.getItem('review_access_token'),
  );
  const [hash, setHash] = useState(location.hash || '#/');

  useEffect(() => {
    const routeChanged = (): void => setHash(location.hash || '#/');
    const authenticationExpired = (): void => setToken(null);
    window.addEventListener('hashchange', routeChanged);
    window.addEventListener(
      'incident-review:authentication-expired',
      authenticationExpired,
    );
    return () => {
      window.removeEventListener('hashchange', routeChanged);
      window.removeEventListener(
        'incident-review:authentication-expired',
        authenticationExpired,
      );
    };
  }, []);

  if (token === null) {
    return <SignIn configuration={configuration} />;
  }
  const incidentMatch = /^#\/incidents\/([0-9a-f-]{36})$/iu.exec(hash);
  const integrations = hash === '#/settings/integrations';
  return (
    <ApplicationErrorBoundary>
      {integrations ? (
        <SlackConnectionPage
          apiClient={apiClient}
          callbackResult={slackCallbackResult}
          configuration={configuration}
          token={token}
        />
      ) : incidentMatch?.[1] === undefined ? (
        <InboxPage
          apiClient={apiClient}
          configuration={configuration}
          token={token}
        />
      ) : (
        <IncidentPage
          apiClient={apiClient}
          configuration={configuration}
          incidentId={incidentMatch[1]}
          token={token}
        />
      )}
    </ApplicationErrorBoundary>
  );
}

export function SlackConnectionPage({
  apiClient,
  callbackResult = null,
  configuration,
  token,
}: {
  readonly apiClient: ReviewApiClient;
  readonly callbackResult?: SlackOnboardingCallbackResult | null;
  readonly configuration: Configuration;
  readonly token: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [disconnectWorkspace, setDisconnectWorkspace] = useState<{
    readonly workspaceId: string;
    readonly displayName: string;
    readonly retrying: boolean;
  } | null>(null);
  const status = useQuery({
    queryKey: ['slack-onboarding-status'],
    queryFn: async () =>
      slackOnboardingStatusSchema.parse(
        await apiClient(
          configuration,
          token,
          '/review/onboarding/slack/status',
        ),
      ),
  });
  const connect = useMutation({
    mutationFn: () => requestSlackAuthorization(configuration, token),
    onSuccess: (authorizationUrl) => location.assign(authorizationUrl),
  });
  const disconnect = useMutation({
    mutationFn: async (workspaceId: string) =>
      slackDisconnectionResponseSchema.parse(
        await apiClient(
          configuration,
          token,
          `/onboarding/slack/${encodeURIComponent(workspaceId)}/disconnect`,
          {
            method: 'POST',
            body: JSON.stringify({ confirmation: workspaceId }),
          },
        ),
      ),
    onSuccess: () => setDisconnectWorkspace(null),
    onSettled: async () =>
      queryClient.invalidateQueries({ queryKey: ['slack-onboarding-status'] }),
  });

  useEffect(() => {
    if (disconnectWorkspace === null || disconnect.isPending) {
      return;
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDisconnectWorkspace(null);
      }
    };
    document.addEventListener('keydown', dismissOnEscape);
    return () => document.removeEventListener('keydown', dismissOnEscape);
  }, [disconnect.isPending, disconnectWorkspace]);

  return (
    <AppFrame configuration={configuration}>
      <main className="page-shell integration-page">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <a href="#/">
            <ArrowLeft size={16} /> Review inbox
          </a>
          <ChevronRight size={15} aria-hidden="true" />
          <span>Integrations</span>
        </nav>

        <section className="integration-hero reveal">
          <div>
            <p className="eyebrow">Workspace settings</p>
            <h1>Slack connection</h1>
            <p className="hero-copy">
              Authorize OnRecord once. Workspace credentials remain encrypted
              and are never shown in this browser.
            </p>
          </div>
          <span className="integration-hero-icon" aria-hidden="true">
            <MessageSquareText size={30} />
          </span>
        </section>

        {callbackResult !== null && (
          <div
            className="connection-notice"
            data-tone={callbackResult === 'connected' ? 'success' : 'error'}
            role="status"
          >
            {callbackResult === 'connected' ? (
              <CheckCircle2 size={19} />
            ) : (
              <AlertCircle size={19} />
            )}
            <span>
              <strong>
                {callbackResult === 'connected'
                  ? 'Slack connected'
                  : 'Slack connection was not completed'}
              </strong>
              {callbackResult === 'connected'
                ? ' The workspace is ready for incident collection.'
                : ' Review the status below and try again, or contact an administrator.'}
            </span>
          </div>
        )}

        {disconnect.isSuccess && (
          <div className="connection-notice" role="status">
            <CheckCircle2 size={19} />
            <span>
              <strong>Slack disconnected</strong> OnRecord can no longer use
              that workspace credential. Historical incident records were
              preserved.
            </span>
          </div>
        )}

        {status.isPending ? (
          <section
            className="connection-card connection-loading"
            aria-live="polite"
          >
            <LoaderCircle className="spin" size={21} /> Loading Slack status…
          </section>
        ) : status.isError ? (
          <section className="connection-card">
            <AlertCircle size={22} />
            <div>
              <h2>Connection status unavailable</h2>
              <p>{userFacingError(status.error)}</p>
              <button
                className="button button-secondary"
                onClick={() => void status.refetch()}
              >
                Try again
              </button>
            </div>
          </section>
        ) : (
          <section className="connection-stack" aria-label="Slack workspaces">
            {status.data.workspaces.length > 0 &&
              status.data.canStartInstallation && (
                <div className="connection-actions">
                  <div>
                    <h2>Add another workspace</h2>
                    <p>
                      Slack will ask you to choose and authorize the workspace
                      you want to connect.
                    </p>
                  </div>
                  <button
                    className="button button-primary"
                    disabled={connect.isPending}
                    onClick={() => connect.mutate()}
                  >
                    {connect.isPending ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Plus size={18} />
                    )}
                    {connect.isPending ? 'Opening Slack…' : 'Add workspace'}
                  </button>
                </div>
              )}
            {status.data.workspaces.length === 0 ? (
              <DisconnectedSlackCard
                canConnect={status.data.canStartInstallation}
                connecting={connect.isPending}
                onConnect={() => connect.mutate()}
              />
            ) : (
              status.data.workspaces.map((workspace) => (
                <article
                  className="connection-card"
                  key={workspace.workspaceId}
                >
                  <span
                    className="connection-status-icon"
                    data-status={workspace.connectionStatus}
                    aria-hidden="true"
                  >
                    {workspace.connectionStatus === 'CONNECTED' ? (
                      <CheckCircle2 size={23} />
                    ) : (
                      <Unplug size={23} />
                    )}
                  </span>
                  <div className="connection-card-copy">
                    <div className="connection-card-heading">
                      <div>
                        <p className="eyebrow">Slack workspace</p>
                        <h2>{workspace.displayName}</h2>
                      </div>
                      <ConnectionStatusPill
                        status={workspace.connectionStatus}
                      />
                    </div>
                    <p>
                      Workspace ID {workspace.workspaceId} · Your role:{' '}
                      {workspace.role === 'ADMIN'
                        ? 'Administrator'
                        : 'Reviewer'}
                    </p>
                    <p className="connection-meta">
                      {workspace.installedAt === null
                        ? 'Not connected yet'
                        : `Connected ${new Date(
                            workspace.installedAt,
                          ).toLocaleDateString()}`}
                      {' · '}Updated {formatRelativeTime(workspace.updatedAt)}
                      {workspace.credentialExpiresAt === null
                        ? ''
                        : ` · Credential expires ${new Date(
                            workspace.credentialExpiresAt,
                          ).toLocaleDateString()}`}
                    </p>
                    {workspace.connectionStatus !== 'CONNECTED' &&
                      workspace.connectionStatus !== 'DISCONNECTING' &&
                      workspace.canManage && (
                        <button
                          className="button button-primary"
                          disabled={connect.isPending}
                          onClick={() => connect.mutate()}
                        >
                          {connect.isPending ? (
                            <LoaderCircle className="spin" size={18} />
                          ) : (
                            <RotateCcw size={18} />
                          )}
                          {connect.isPending
                            ? 'Opening Slack…'
                            : 'Reconnect Slack'}
                        </button>
                      )}
                    {workspace.connectionStatus === 'CONNECTED' &&
                      workspace.canManage && (
                        <button
                          className="button button-danger-secondary"
                          disabled={disconnect.isPending}
                          onClick={() => {
                            disconnect.reset();
                            setDisconnectWorkspace({
                              workspaceId: workspace.workspaceId,
                              displayName: workspace.displayName,
                              retrying: false,
                            });
                          }}
                        >
                          <Unplug size={18} /> Disconnect workspace
                        </button>
                      )}
                    {workspace.connectionStatus === 'DISCONNECTING' &&
                      workspace.canManage && (
                        <button
                          className="button button-danger-secondary"
                          disabled={disconnect.isPending}
                          onClick={() => {
                            disconnect.reset();
                            setDisconnectWorkspace({
                              workspaceId: workspace.workspaceId,
                              displayName: workspace.displayName,
                              retrying: true,
                            });
                          }}
                        >
                          <RotateCcw size={18} /> Retry disconnect
                        </button>
                      )}
                    {!workspace.canManage &&
                      workspace.connectionStatus !== 'CONNECTED' && (
                        <p className="connection-guidance">
                          A workspace administrator must reconnect Slack.
                        </p>
                      )}
                  </div>
                </article>
              ))
            )}
            {connect.isError && (
              <p className="form-notice" data-error="true" role="alert">
                <AlertCircle size={16} /> {userFacingError(connect.error)}
              </p>
            )}
          </section>
        )}
      </main>
      {disconnectWorkspace !== null && (
        <div className="confirmation-scrim">
          <section
            className="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="disconnect-dialog-title"
            aria-describedby="disconnect-dialog-description"
          >
            <span className="confirmation-dialog-icon" aria-hidden="true">
              <TriangleAlert size={24} />
            </span>
            <div>
              <p className="eyebrow">Workspace access</p>
              <h2 id="disconnect-dialog-title">
                {disconnectWorkspace.retrying
                  ? 'Finish disconnecting Slack?'
                  : 'Disconnect this workspace?'}
              </h2>
              <p id="disconnect-dialog-description">
                OnRecord will stop collecting Slack evidence and sending Slack
                notifications for{' '}
                <strong>{disconnectWorkspace.displayName}</strong>. Historical
                incidents and reports will not be deleted.
              </p>
              <p className="confirmation-workspace-id">
                Workspace ID {disconnectWorkspace.workspaceId}
              </p>
              {disconnect.isError && (
                <p className="form-notice" data-error="true" role="alert">
                  <AlertCircle size={16} />{' '}
                  {disconnectFacingError(disconnect.error)}
                </p>
              )}
              <div className="confirmation-dialog-actions">
                <button
                  className="button button-secondary"
                  autoFocus
                  disabled={disconnect.isPending}
                  onClick={() => setDisconnectWorkspace(null)}
                >
                  Cancel
                </button>
                <button
                  className="button button-danger"
                  disabled={disconnect.isPending}
                  onClick={() =>
                    disconnect.mutate(disconnectWorkspace.workspaceId)
                  }
                >
                  {disconnect.isPending ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Unplug size={18} />
                  )}
                  {disconnect.isPending
                    ? 'Disconnecting…'
                    : disconnectWorkspace.retrying
                      ? 'Retry disconnect'
                      : 'Disconnect workspace'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}

function DisconnectedSlackCard({
  canConnect,
  connecting,
  onConnect,
}: {
  readonly canConnect: boolean;
  readonly connecting: boolean;
  readonly onConnect: () => void;
}): ReactNode {
  return (
    <article className="connection-card">
      <span className="connection-status-icon" data-status="NOT_CONNECTED">
        <Unplug size={23} />
      </span>
      <div className="connection-card-copy">
        <p className="eyebrow">Slack workspace</p>
        <h2>Slack is not connected</h2>
        <p>
          Connect a workspace to open incident-scoping modals, collect evidence,
          and receive review notifications.
        </p>
        {canConnect ? (
          <button
            className="button button-primary"
            disabled={connecting}
            onClick={onConnect}
          >
            {connecting ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <MessageSquareText size={18} />
            )}
            {connecting ? 'Opening Slack…' : 'Connect to Slack'}
          </button>
        ) : (
          <p className="connection-guidance">
            Your account cannot manage workspace integrations. Contact an
            OnRecord administrator.
          </p>
        )}
      </div>
    </article>
  );
}

function ConnectionStatusPill({
  status,
}: {
  readonly status:
    | 'NOT_CONNECTED'
    | 'CONNECTING'
    | 'CONNECTED'
    | 'RECONNECT_REQUIRED'
    | 'DISCONNECTING'
    | 'DISCONNECTED'
    | 'FAILED';
}): ReactNode {
  const label: Record<typeof status, string> = {
    NOT_CONNECTED: 'Not connected',
    CONNECTING: 'Connecting',
    CONNECTED: 'Connected',
    RECONNECT_REQUIRED: 'Reconnect required',
    DISCONNECTING: 'Disconnecting',
    DISCONNECTED: 'Disconnected',
    FAILED: 'Setup failed',
  };
  return (
    <span className="connection-status-pill" data-status={status}>
      {label[status]}
    </span>
  );
}

function disconnectFacingError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Only an active workspace administrator can disconnect Slack.';
    }
    if (error.status === 409) {
      return 'The workspace connection changed during this request. Refresh and try again.';
    }
    if (error.status === 503) {
      return 'Slack or credential cleanup is temporarily unavailable. Retry this disconnect.';
    }
  }
  return userFacingError(error);
}

export function DemoReviewApplication({
  apiClient,
  configuration,
  incidentId,
}: {
  readonly apiClient: ReviewApiClient;
  readonly configuration: Configuration;
  readonly incidentId: string;
}): ReactNode {
  const defaultRoute = `#/incidents/${incidentId}`;
  const [hash, setHash] = useState(location.hash || defaultRoute);

  useEffect(() => {
    if (location.hash === '') {
      history.replaceState({}, '', `${location.pathname}${defaultRoute}`);
    }
    const routeChanged = (): void => setHash(location.hash || defaultRoute);
    window.addEventListener('hashchange', routeChanged);
    return () => window.removeEventListener('hashchange', routeChanged);
  }, [defaultRoute]);

  const incidentMatch = /^#\/incidents\/([0-9a-f-]{36})$/iu.exec(hash);
  return (
    <ApplicationErrorBoundary>
      {incidentMatch?.[1] === undefined ? (
        <InboxPage
          apiClient={apiClient}
          configuration={configuration}
          experience="demo"
          token="synthetic-demo"
        />
      ) : (
        <IncidentPage
          apiClient={apiClient}
          configuration={configuration}
          experience="demo"
          incidentId={incidentMatch[1]}
          token="synthetic-demo"
        />
      )}
    </ApplicationErrorBoundary>
  );
}

export function StartupFailure(): ReactNode {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="error-state mx-auto max-w-xl">
        <div className="error-icon" aria-hidden="true">
          <AlertCircle size={24} />
        </div>
        <p className="eyebrow">Unable to start</p>
        <h1>OnRecord needs a moment.</h1>
        <p>
          We could not initialize the secure review experience. Refresh the
          page, and contact the incident platform owner if the problem remains.
        </p>
        <button
          className="button button-primary"
          onClick={() => location.reload()}
        >
          Try again
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
    </main>
  );
}

function SignIn({
  configuration,
}: {
  readonly configuration: Configuration;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <main className="auth-shell">
      <section className="auth-story" aria-labelledby="auth-story-title">
        <Brand light />
        <div className="auth-copy">
          <p className="eyebrow eyebrow-light">OnRecord</p>
          <h1 id="auth-story-title">Put every incident on the record.</h1>
          <p>
            Turn fragmented incident conversations into an evidence-linked
            postmortem your team can verify, revise, and approve.
          </p>
          <div className="auth-proof" aria-label="Product safeguards">
            <span>
              <ShieldCheck size={17} /> Source linked
            </span>
            <span>
              <BadgeCheck size={17} /> Human approved
            </span>
            <span>
              <History size={17} /> History preserved
            </span>
          </div>
        </div>
        <div className="signal-visual" aria-hidden="true">
          <div className="signal-ring signal-ring-one" />
          <div className="signal-ring signal-ring-two" />
          <div className="signal-core">
            <Sparkles size={22} />
          </div>
          <div className="signal-node signal-node-one" />
          <div className="signal-node signal-node-two" />
          <div className="signal-node signal-node-three" />
        </div>
      </section>
      <section className="auth-panel" aria-labelledby="sign-in-title">
        <div className="auth-card">
          <div className="auth-card-mark" aria-hidden="true">
            <ShieldCheck />
          </div>
          <p className="eyebrow">Secure workspace</p>
          <h2 id="sign-in-title">Continue to OnRecord</h2>
          <p className="muted-copy">
            Sign in with your reviewer account. Access is checked against your
            active workspace membership for every incident.
          </p>
          <button
            className="button button-primary button-large"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void startAuthorization(configuration).catch(() =>
                setBusy(false),
              );
            }}
          >
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <ShieldCheck size={18} />
            )}
            {busy ? 'Redirecting securely…' : 'Sign in securely'}
          </button>
          <div className="security-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Authorization code with PKCE · short-lived session</span>
          </div>
        </div>
      </section>
    </main>
  );
}

function InboxPage({
  apiClient,
  configuration,
  experience = 'production',
  token,
}: {
  readonly apiClient: ReviewApiClient;
  readonly configuration: Configuration;
  readonly experience?: Experience;
  readonly token: string;
}): ReactNode {
  const [filter, setFilter] = useState<InboxFilter>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const query = useQuery({
    queryKey: ['review-inbox'],
    queryFn: async () =>
      inboxSchema.parse(
        await apiClient(configuration, token, '/review/incidents?limit=50'),
      ),
  });

  if (query.isPending) {
    return <PageLoading label="Preparing your review inbox" />;
  }
  if (query.isError) {
    return (
      <RequestFailure
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const visibleItems = query.data.items.filter(
    (incident) =>
      (filter === 'ALL' || incident.status === filter) &&
      (normalizedSearch === '' ||
        incident.title.toLowerCase().includes(normalizedSearch) ||
        incident.severity.toLowerCase().includes(normalizedSearch)),
  );
  const needsReviewCount = query.data.items.filter(
    (incident) => incident.status === 'NEEDS_REVIEW',
  ).length;
  const approvedCount = query.data.items.length - needsReviewCount;
  const contradictionCount = query.data.items.reduce(
    (total, incident) => total + incident.contradictionCount,
    0,
  );

  return (
    <AppFrame configuration={configuration} experience={experience}>
      <main className="page-shell">
        <section className="inbox-hero reveal">
          <div>
            <p className="eyebrow">OnRecord review workspace</p>
            <h1>Build a record your team can trust.</h1>
            <p className="hero-copy">
              Check every claim against its source, resolve what remains
              uncertain, and preserve every human correction before approval.
            </p>
          </div>
          <div className="inbox-focus">
            <span className="focus-label">Today’s focus</span>
            <strong>{needsReviewCount}</strong>
            <span>
              {needsReviewCount === 1 ? 'incident needs' : 'incidents need'}{' '}
              your review
            </span>
          </div>
        </section>

        <section
          className="metric-grid reveal reveal-delay-one"
          aria-label="Review summary"
        >
          <MetricCard
            icon={<Inbox />}
            label="Awaiting review"
            value={needsReviewCount}
            tone="violet"
          />
          <MetricCard
            icon={<CheckCircle2 />}
            label="Approved"
            value={approvedCount}
            tone="green"
          />
          <MetricCard
            icon={<TriangleAlert />}
            label="Contradictions"
            value={contradictionCount}
            tone="amber"
          />
          <MetricCard
            icon={<FileText />}
            label="Total incidents"
            value={query.data.items.length}
            tone="blue"
          />
        </section>

        <section className="inbox-section reveal reveal-delay-two">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">Incident queue</p>
              <h2>Incident records</h2>
            </div>
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">Search incidents</span>
              <input
                type="search"
                value={searchTerm}
                placeholder="Search incidents"
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </label>
          </div>
          <div
            className="filter-row"
            role="group"
            aria-label="Filter incidents"
          >
            {(['ALL', 'NEEDS_REVIEW', 'APPROVED'] as const).map((value) => (
              <button
                className="filter-button"
                data-active={filter === value}
                key={value}
                onClick={() => setFilter(value)}
              >
                {value === 'ALL' ? 'All incidents' : humanize(value)}
              </button>
            ))}
          </div>
          {visibleItems.length === 0 ? (
            <EmptyInbox hasIncidents={query.data.items.length > 0} />
          ) : (
            <div className="incident-list">
              {visibleItems.map((incident) => (
                <IncidentCard incident={incident} key={incident.incidentId} />
              ))}
            </div>
          )}
        </section>
      </main>
    </AppFrame>
  );
}

function IncidentCard({
  incident,
}: {
  readonly incident: InboxItem;
}): ReactNode {
  const riskCount = incident.contradictionCount + incident.openQuestionCount;
  return (
    <button
      className="incident-card"
      onClick={() => {
        location.hash = `#/incidents/${incident.incidentId}`;
      }}
    >
      <span
        className={`severity-marker severity-${severityTone(incident.severity)}`}
        aria-hidden="true"
      />
      <span className="incident-main">
        <span className="incident-title-row">
          <strong>{incident.title}</strong>
          <StatusPill status={incident.status} />
        </span>
        <span className="incident-subtitle">
          {incident.severity} · Updated {formatRelativeTime(incident.updatedAt)}
          {incident.latestRevisionNumber === null
            ? ' · Original AI draft'
            : ` · Revision ${incident.latestRevisionNumber}`}
        </span>
      </span>
      <span className="incident-facts" aria-label="Incident review facts">
        <Fact label="claims" value={incident.claimCount} />
        <Fact label="timeline events" value={incident.timelineEventCount} />
        <Fact label="review flags" value={riskCount} warning={riskCount > 0} />
      </span>
      <span className="incident-open" aria-hidden="true">
        <ChevronRight size={20} />
      </span>
    </button>
  );
}

function IncidentPage({
  apiClient,
  configuration,
  experience = 'production',
  incidentId,
  token,
}: {
  readonly apiClient: ReviewApiClient;
  readonly configuration: Configuration;
  readonly experience?: Experience;
  readonly incidentId: string;
  readonly token: string;
}): ReactNode {
  const query = useQuery({
    queryKey: ['incident-review', incidentId],
    queryFn: async () =>
      bundleSchema.parse(
        await apiClient(
          configuration,
          token,
          `/review/incidents/${encodeURIComponent(incidentId)}`,
        ),
      ),
  });
  if (query.isPending) {
    return <PageLoading label="Assembling the evidence workspace" />;
  }
  if (query.isError) {
    return (
      <RequestFailure
        error={query.error}
        onRetry={() => void query.refetch()}
        back
      />
    );
  }
  return (
    <AppFrame configuration={configuration} compact experience={experience}>
      <IncidentWorkspace
        apiClient={apiClient}
        bundle={query.data}
        configuration={configuration}
        experience={experience}
        token={token}
      />
    </AppFrame>
  );
}

function IncidentWorkspace({
  apiClient,
  bundle,
  configuration,
  experience,
  token,
}: {
  readonly apiClient: ReviewApiClient;
  readonly bundle: Bundle;
  readonly configuration: Configuration;
  readonly experience: Experience;
  readonly token: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<EvidenceTab>('questions');
  const [pendingEvidenceFocus, setPendingEvidenceFocus] = useState<{
    readonly id: string;
    readonly trigger: HTMLButtonElement;
  } | null>(null);
  const evidenceFocus = useRef<EvidenceFocus | null>(null);
  const [statementStates, setStatementStates] = useState(() =>
    createStatementStates(bundle),
  );
  const [additionalStatements, setAdditionalStatements] = useState<
    readonly AdditionalStatementState[]
  >(() => createAdditionalStatementStates(bundle.latestRevision));
  const [questionAnswers, setQuestionAnswers] = useState(() =>
    createQuestionAnswerStates(bundle),
  );
  const [acknowledgedContradictions, setAcknowledgedContradictions] = useState(
    bundle.latestRevision?.acknowledgedContradictions ?? false,
  );
  const [acknowledgedQuestions, setAcknowledgedQuestions] = useState(
    bundle.latestRevision?.acknowledgedOpenQuestions ?? false,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [tourOpen, setTourOpen] = useState(
    () => experience === 'demo' && !hasCompletedDemoTour(),
  );
  const revisionIdentity = bundle.latestRevision?.id ?? bundle.reportDraft.id;
  const [selectedVersionId, setSelectedVersionId] = useState(revisionIdentity);
  const selectedIsOriginal = selectedVersionId === bundle.reportDraft.id;
  const selectedIsLatest = selectedVersionId === revisionIdentity;
  const selectedRequiresFetch = requiresPreservedRevisionFetch(
    selectedVersionId,
    bundle.reportDraft.id,
    revisionIdentity,
  );
  const selectedRevisionQuery = useQuery({
    queryKey: [
      'incident-review-revision',
      bundle.incident.id,
      selectedVersionId,
    ],
    queryFn: async () =>
      revisionDetailResponseSchema.parse(
        await apiClient(
          configuration,
          token,
          `/review/incidents/${encodeURIComponent(bundle.incident.id)}/revisions/${encodeURIComponent(selectedVersionId)}`,
        ),
      ).revision,
    enabled: selectedRequiresFetch,
  });
  const selectedRevision: RevisionDetail | null = selectedIsOriginal
    ? null
    : selectedIsLatest
      ? bundle.latestRevision
      : (selectedRevisionQuery.data ?? null);
  const selectedVersionIdentity = selectedRevision?.id ?? selectedVersionId;

  useEffect(() => {
    setSelectedVersionId(revisionIdentity);
  }, [revisionIdentity]);

  useEffect(() => {
    if (!selectedIsOriginal && selectedRevision === null) {
      return;
    }
    setStatementStates(
      createStatementStates(bundle, selectedRevision?.statements ?? null),
    );
    setQuestionAnswers(
      createQuestionAnswerStates(
        bundle,
        selectedRevision?.questionAnswers ?? null,
      ),
    );
    setAdditionalStatements(createAdditionalStatementStates(selectedRevision));
    setAcknowledgedContradictions(
      selectedRevision?.acknowledgedContradictions ?? false,
    );
    setAcknowledgedQuestions(
      selectedRevision?.acknowledgedOpenQuestions ?? false,
    );
  }, [bundle, selectedIsOriginal, selectedRevision, selectedVersionIdentity]);

  const saveRevision = useMutation({
    mutationFn: async () => {
      const decisions = Object.entries(statementStates).map(
        ([statementId, state]) =>
          state.decision === 'EDIT'
            ? {
                statementId,
                decision: state.decision,
                text: state.text,
                classification: state.classification,
              }
            : { statementId, decision: state.decision },
      );
      const answeredQuestions = Object.entries(questionAnswers)
        .map(([questionId, answer]) => ({
          questionId,
          answer: answer.trim(),
        }))
        .filter((answer) => answer.answer.length > 0);
      return revisionResponseSchema.parse(
        await apiClient(
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
              acknowledgedContradictions,
              acknowledgedOpenQuestions: acknowledgedQuestions,
              questionAnswers: answeredQuestions,
              additionalStatements,
              decisions,
            }),
          },
        ),
      );
    },
    onSuccess: async (result) => {
      setNotice(
        `Revision ${result.revision.revisionNumber} saved and preserved.`,
      );
      await queryClient.invalidateQueries({
        queryKey: ['incident-review', bundle.incident.id],
      });
      await queryClient.invalidateQueries({ queryKey: ['review-inbox'] });
    },
  });

  const displayedDraft =
    selectedIsLatest && selectedRevision?.status === 'DRAFT'
      ? selectedRevision
      : null;
  const approveRevision = useMutation({
    mutationFn: async () => {
      if (displayedDraft === null) {
        throw new Error('No displayed draft is available for approval');
      }
      await apiClient(
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
    },
    onSuccess: async () => {
      setNotice('The reviewed revision is approved and on the record.');
      await queryClient.invalidateQueries({
        queryKey: ['incident-review', bundle.incident.id],
      });
      await queryClient.invalidateQueries({ queryKey: ['review-inbox'] });
    },
  });

  const editable =
    bundle.incident.status === 'NEEDS_REVIEW' && selectedIsLatest;
  const contradictionCount = bundle.claims.filter(
    (claim) =>
      claim.classification === 'disputed' ||
      claim.contradictingEvidenceIds.length > 0,
  ).length;
  const busy = saveRevision.isPending || approveRevision.isPending;
  const operationError = saveRevision.error ?? approveRevision.error;
  const additionalStatementsValid = additionalStatements.every(
    (statement) =>
      statement.text.trim().length > 0 &&
      (statement.claimIds.length > 0 || statement.timelineEventIds.length > 0),
  );

  useEffect(() => {
    if (pendingEvidenceFocus === null) return;
    let followUpFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      followUpFrame = window.requestAnimationFrame(() => {
        evidenceFocus.current = focusEvidenceSource(
          pendingEvidenceFocus.id,
          pendingEvidenceFocus.trigger,
        );
        setPendingEvidenceFocus(null);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (followUpFrame !== undefined) {
        window.cancelAnimationFrame(followUpFrame);
      }
    };
  }, [activeTab, pendingEvidenceFocus]);

  useEffect(() => () => clearEvidenceFocus(evidenceFocus.current), []);

  const openSource = (id: string, trigger: HTMLButtonElement): void => {
    const targetTab = sourceTab(bundle, id);
    clearEvidenceFocus(evidenceFocus.current);
    evidenceFocus.current = null;
    setActiveTab(targetTab);
    setPendingEvidenceFocus({ id, trigger });
  };

  return (
    <main className="incident-page">
      <nav className="breadcrumb reveal" aria-label="Breadcrumb">
        <button
          onClick={() => {
            location.hash = '#/';
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" /> Review inbox
        </button>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">Incident review</span>
        {experience === 'demo' && (
          <button
            className="tour-replay-button"
            onClick={() => setTourOpen(true)}
            type="button"
          >
            <Compass size={15} /> <span>Guided tour</span>
          </button>
        )}
      </nav>

      <section
        className="incident-hero reveal reveal-delay-one"
        data-tour-target="incident-summary"
      >
        <div className="incident-hero-main">
          <div className="incident-status-row">
            <StatusPill status={bundle.incident.status} />
            <span
              className={`severity-pill severity-${severityTone(bundle.incident.severity)}`}
            >
              {bundle.incident.severity}
            </span>
          </div>
          <h1>{bundle.incident.title}</h1>
          <p className="revision-context">
            {selectedIsOriginal ? (
              <>
                <Sparkles size={16} /> Original AI draft{' '}
                {bundle.reportDraft.draftVersion}
              </>
            ) : selectedRevision === null ? (
              <>
                <LoaderCircle className="spin" size={16} /> Loading preserved
                revision
              </>
            ) : (
              <>
                <History size={16} /> Human revision{' '}
                {selectedRevision.revisionNumber} ·{' '}
                {humanize(selectedRevision.status)}
              </>
            )}
            <span>Based on incident version {bundle.incident.version}</span>
          </p>
        </div>
        <div className="incident-health" aria-label="Review readiness">
          <span className="health-ring">
            {bundle.incident.status === 'APPROVED' ? (
              <Check size={25} />
            ) : (
              <FileCheck2 size={25} />
            )}
          </span>
          <span>
            <small>
              {bundle.incident.status === 'APPROVED'
                ? 'Review complete'
                : 'Review in progress'}
            </small>
            <strong>{bundle.sections.length} report sections</strong>
          </span>
        </div>
      </section>

      <section
        className="incident-metrics reveal reveal-delay-two"
        aria-label="Incident evidence summary"
      >
        <CompactMetric
          icon={<MessageSquareText />}
          value={bundle.claims.length}
          label="claims"
        />
        <CompactMetric
          icon={<Clock3 />}
          value={bundle.timeline.length}
          label="timeline events"
        />
        <CompactMetric
          icon={<CircleHelp />}
          value={bundle.openQuestions.length}
          label="open questions"
          warning={bundle.openQuestions.length > 0}
        />
        <CompactMetric
          icon={<TriangleAlert />}
          value={contradictionCount}
          label="contradictions"
          warning={contradictionCount > 0}
        />
        <CompactMetric
          icon={<Link2 />}
          value={bundle.evidence.length}
          label="evidence sources"
        />
      </section>

      <div className="review-layout reveal reveal-delay-three">
        <section
          className="report-workspace"
          data-tour-target="report"
          aria-labelledby="report-title"
        >
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">On the record</p>
              <h2 id="report-title">Incident report</h2>
            </div>
            <label className="version-picker">
              <span>
                <History size={14} /> Version history
              </span>
              <select
                aria-label="Displayed report version"
                value={selectedVersionId}
                onChange={(event) => setSelectedVersionId(event.target.value)}
              >
                {bundle.revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    Revision {revision.revisionNumber} ·{' '}
                    {humanize(revision.status)} ·{' '}
                    {formatCalendarDate(revision.createdAt)}
                  </option>
                ))}
                <option value={bundle.reportDraft.id}>
                  Original AI draft · Version {bundle.reportDraft.draftVersion}
                </option>
              </select>
            </label>
          </div>
          {selectedRequiresFetch && selectedRevisionQuery.isPending && (
            <p className="version-message">
              <LoaderCircle className="spin" size={15} /> Loading preserved
              revision…
            </p>
          )}
          {selectedRequiresFetch && selectedRevisionQuery.isError && (
            <p className="version-message version-message-error">
              <AlertCircle size={15} /> This preserved revision could not be
              loaded.
            </p>
          )}
          {(selectedIsOriginal || selectedRevision !== null) && (
            <div className="report-sections">
              {bundle.sections.map((section, sectionIndex) => (
                <section className="report-section" key={section.sectionType}>
                  <header className="report-section-heading">
                    <span>{String(sectionIndex + 1).padStart(2, '0')}</span>
                    <h3>{humanize(section.sectionType)}</h3>
                    <small>
                      {section.statements.length +
                        additionalStatements.filter(
                          (statement) =>
                            statement.sectionType === section.sectionType,
                        ).length}{' '}
                      {section.statements.length +
                        additionalStatements.filter(
                          (statement) =>
                            statement.sectionType === section.sectionType,
                        ).length ===
                      1
                        ? 'statement'
                        : 'statements'}
                    </small>
                  </header>
                  <div className="statement-list">
                    {section.statements.length === 0 &&
                      additionalStatements.every(
                        (statement) =>
                          statement.sectionType !== section.sectionType,
                      ) && (
                        <div className="empty-section-warning">
                          <TriangleAlert size={16} />
                          <span>
                            <strong>No statement was generated here.</strong>
                            Review the available evidence and add a
                            source-linked statement when this incident contains
                            relevant facts.
                          </span>
                        </div>
                      )}
                    {section.statements.map((statement) => {
                      const state = statementStates[statement.id];
                      if (state === undefined) {
                        throw new Error('Report statement has no review state');
                      }
                      return (
                        <StatementEditor
                          editable={editable}
                          key={statement.id}
                          onChange={(next) =>
                            setStatementStates((current) => ({
                              ...current,
                              [statement.id]: next,
                            }))
                          }
                          onOpenSource={openSource}
                          state={state}
                          statement={statement}
                        />
                      );
                    })}
                    {additionalStatements
                      .filter(
                        (statement) =>
                          statement.sectionType === section.sectionType,
                      )
                      .map((statement) => (
                        <AdditionalStatementEditor
                          bundle={bundle}
                          editable={editable}
                          key={statement.clientStatementId}
                          onChange={(next) =>
                            setAdditionalStatements((current) =>
                              current.map((candidate) =>
                                candidate.clientStatementId ===
                                next.clientStatementId
                                  ? next
                                  : candidate,
                              ),
                            )
                          }
                          onOpenSource={openSource}
                          onRemove={() =>
                            setAdditionalStatements((current) =>
                              current.filter(
                                (candidate) =>
                                  candidate.clientStatementId !==
                                  statement.clientStatementId,
                              ),
                            )
                          }
                          statement={statement}
                        />
                      ))}
                    {editable && (
                      <button
                        className="add-statement-button"
                        onClick={() =>
                          setAdditionalStatements((current) => [
                            ...current,
                            {
                              clientStatementId: crypto.randomUUID(),
                              sectionType: section.sectionType,
                              text: '',
                              classification: 'participant_assertion',
                              claimIds: [],
                              timelineEventIds: [],
                            },
                          ])
                        }
                        type="button"
                      >
                        <Plus size={16} /> Add evidence-backed statement
                      </button>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>

        <EvidenceWorkspace
          activeTab={activeTab}
          bundle={bundle}
          editable={editable}
          questionAnswers={questionAnswers}
          onQuestionAnswerChange={(questionId, answer) =>
            setQuestionAnswers((current) => ({
              ...current,
              [questionId]: answer,
            }))
          }
          onOpenSource={openSource}
          onTabChange={setActiveTab}
        />
      </div>

      {editable ? (
        <ReviewActionBar
          acknowledgedContradictions={acknowledgedContradictions}
          acknowledgedQuestions={acknowledgedQuestions}
          approveDisabled={displayedDraft === null}
          busy={busy}
          error={operationError}
          notice={notice}
          onAcknowledgedContradictions={setAcknowledgedContradictions}
          onAcknowledgedQuestions={setAcknowledgedQuestions}
          onApprove={() => approveRevision.mutate()}
          onSave={() => {
            if (!additionalStatementsValid) {
              setNotice(
                'Complete every added statement and link at least one source before saving.',
              );
              return;
            }
            saveRevision.mutate();
          }}
        />
      ) : (
        <section
          className="approved-banner reveal"
          aria-label="Read-only report version"
        >
          <span>
            <CheckCircle2 size={22} />
          </span>
          <div>
            <strong>
              {selectedRevision?.status === 'APPROVED'
                ? 'Approved record locked'
                : 'Preserved historical version'}
            </strong>
            <p>
              This version is immutable and displayed read-only. Use Version
              history to compare it with earlier or later revisions.
            </p>
          </div>
        </section>
      )}
      {experience === 'demo' && (
        <GuidedTour open={tourOpen} onClose={() => setTourOpen(false)} />
      )}
    </main>
  );
}

export function StatementEditor({
  editable,
  onChange,
  onOpenSource,
  state,
  statement,
}: {
  readonly editable: boolean;
  readonly onChange: (state: StatementState) => void;
  readonly onOpenSource: (id: string, trigger: HTMLButtonElement) => void;
  readonly state: StatementState;
  readonly statement: Statement;
}): ReactNode {
  const setDecision = (decision: ReviewDecision): void => {
    const useSourceContent = decision === 'KEEP' || decision === 'EXCLUDE';
    onChange({
      decision,
      text: useSourceContent ? statement.text : state.text,
      classification: useSourceContent
        ? statement.classification
        : state.classification,
    });
  };
  return (
    <article className="statement-card" data-decision={state.decision}>
      <div className="statement-topline">
        <ClassificationBadge classification={state.classification} />
        <div
          className="decision-control"
          role="group"
          aria-label="Statement decision"
        >
          {(['KEEP', 'EDIT', 'EXCLUDE'] as const).map((decision) => (
            <button
              aria-pressed={state.decision === decision}
              disabled={!editable}
              key={decision}
              onClick={() => setDecision(decision)}
              type="button"
            >
              {decision === 'KEEP' && <Check size={14} />}
              {decision === 'EDIT' && <PencilLine size={14} />}
              {decision === 'EXCLUDE' && <X size={14} />}
              {humanize(decision)}
            </button>
          ))}
        </div>
      </div>
      {state.decision === 'EDIT' ? (
        <div className="statement-editor-fields">
          <label>
            <span>Reviewed statement</span>
            <textarea
              maxLength={4_000}
              value={state.text}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                onChange({ ...state, text: event.target.value })
              }
            />
          </label>
          <label className="classification-field">
            <span>Evidence classification</span>
            <select
              value={state.classification}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                const classification = parseClassification(event.target.value);
                onChange({ ...state, classification });
              }}
            >
              {classificationValues.map((classification) => (
                <option key={classification} value={classification}>
                  {humanize(classification)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="statement-copy">{state.text}</p>
      )}
      {state.decision === 'EXCLUDE' && (
        <p className="exclusion-note">
          <X size={15} /> Excluded from the reviewed report
        </p>
      )}
      <div className="source-chip-row">
        {[...statement.claimIds, ...statement.timelineEventIds].map(
          (sourceId) => (
            <button
              className="source-chip"
              key={sourceId}
              onClick={(event) => onOpenSource(sourceId, event.currentTarget)}
            >
              <Link2 size={13} aria-hidden="true" /> Source {shortId(sourceId)}
            </button>
          ),
        )}
      </div>
    </article>
  );
}

function AdditionalStatementEditor({
  bundle,
  editable,
  onChange,
  onOpenSource,
  onRemove,
  statement,
}: {
  readonly bundle: Bundle;
  readonly editable: boolean;
  readonly onChange: (statement: AdditionalStatementState) => void;
  readonly onOpenSource: (id: string, trigger: HTMLButtonElement) => void;
  readonly onRemove: () => void;
  readonly statement: AdditionalStatementState;
}): ReactNode {
  const sources = [
    ...bundle.claims.map((source) => ({ kind: 'claim' as const, source })),
    ...bundle.timeline.map((source) => ({ kind: 'timeline' as const, source })),
  ];
  const selectedIds = [...statement.claimIds, ...statement.timelineEventIds];
  const toggleSource = (
    kind: (typeof sources)[number]['kind'],
    sourceId: string,
  ): void => {
    const currentIds =
      kind === 'claim' ? statement.claimIds : statement.timelineEventIds;
    const nextIds = currentIds.includes(sourceId)
      ? currentIds.filter((id) => id !== sourceId)
      : [...currentIds, sourceId];
    const nextClaimIds = kind === 'claim' ? nextIds : statement.claimIds;
    const nextTimelineIds =
      kind === 'timeline' ? nextIds : statement.timelineEventIds;
    const selectedClassifications = sources
      .filter(({ kind: sourceKind, source }) =>
        sourceKind === 'claim'
          ? nextClaimIds.includes(source.id)
          : nextTimelineIds.includes(source.id),
      )
      .map(({ source }) => source.classification);
    const minimumClassification = mostCautiousClassification(
      selectedClassifications,
    );
    onChange({
      ...statement,
      classification:
        minimumClassification === null ||
        classificationCaution(statement.classification) >=
          classificationCaution(minimumClassification)
          ? statement.classification
          : minimumClassification,
      claimIds: nextClaimIds,
      timelineEventIds: nextTimelineIds,
    });
  };

  return (
    <article className="statement-card added-statement-card">
      <div className="statement-topline">
        <span className="reviewer-added-badge">
          <Plus size={13} /> Reviewer added
        </span>
        {editable && (
          <button
            aria-label="Remove added statement"
            className="remove-statement-button"
            onClick={onRemove}
            type="button"
          >
            <Trash2 size={15} /> Remove
          </button>
        )}
      </div>
      <div className="statement-editor-fields">
        <label>
          <span>Reviewed statement</span>
          <textarea
            disabled={!editable}
            maxLength={4_000}
            placeholder="Write the report statement supported by the selected evidence…"
            value={statement.text}
            onChange={(event) =>
              onChange({ ...statement, text: event.target.value })
            }
          />
        </label>
        <label className="classification-field">
          <span>Evidence classification</span>
          <select
            disabled={!editable}
            value={statement.classification}
            onChange={(event) =>
              onChange({
                ...statement,
                classification: parseClassification(event.target.value),
              })
            }
          >
            {classificationValues.map((classification) => (
              <option key={classification} value={classification}>
                {humanize(classification)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {editable && (
        <details className="statement-source-picker">
          <summary>
            <Link2 size={15} /> Link existing evidence
            <ChevronDown size={15} />
          </summary>
          <div className="statement-source-options">
            {sources.map(({ kind, source }) => (
              <div className="statement-source-option" key={source.id}>
                <input
                  aria-label={`Link source: ${sourceSummary(source)}`}
                  checked={selectedIds.includes(source.id)}
                  onChange={() => toggleSource(kind, source.id)}
                  type="checkbox"
                />
                <button
                  onClick={(event) =>
                    onOpenSource(source.id, event.currentTarget)
                  }
                  type="button"
                >
                  <span>{sourceSummary(source)}</span>
                  <small>{kind === 'claim' ? 'Claim' : 'Timeline event'}</small>
                  <ClassificationBadge classification={source.classification} />
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="source-chip-row">
        {selectedIds.map((sourceId) => (
          <button
            className="source-chip"
            key={sourceId}
            onClick={(event) => onOpenSource(sourceId, event.currentTarget)}
            type="button"
          >
            <Link2 size={13} /> Source {shortId(sourceId)}
          </button>
        ))}
        {selectedIds.length === 0 && (
          <span className="source-required-note">
            <TriangleAlert size={14} /> Link at least one source
          </span>
        )}
      </div>
    </article>
  );
}

function EvidenceWorkspace({
  activeTab,
  bundle,
  editable,
  onOpenSource,
  onQuestionAnswerChange,
  onTabChange,
  questionAnswers,
}: {
  readonly activeTab: EvidenceTab;
  readonly bundle: Bundle;
  readonly editable: boolean;
  readonly onOpenSource: (id: string, trigger: HTMLButtonElement) => void;
  readonly onQuestionAnswerChange: (questionId: string, answer: string) => void;
  readonly onTabChange: (tab: EvidenceTab) => void;
  readonly questionAnswers: Readonly<Record<string, string>>;
}): ReactNode {
  return (
    <aside
      className="evidence-workspace"
      data-tour-target="evidence"
      aria-labelledby="evidence-title"
    >
      <div className="workspace-heading evidence-heading">
        <div>
          <p className="eyebrow">Evidence on record</p>
          <h2 id="evidence-title">Evidence explorer</h2>
        </div>
        <span className="evidence-total">{bundle.evidence.length} sources</span>
      </div>
      <section className="coverage-panel" aria-labelledby="coverage-title">
        <div className="coverage-heading">
          <div>
            <p className="eyebrow">Collection manifest</p>
            <h3 id="coverage-title">Evidence coverage</h3>
          </div>
          {(bundle.evidenceCoverage.length === 0 ||
            bundle.evidenceCoverage.some(
              (source) => source.state !== 'COMPLETE',
            )) && (
            <span className="coverage-partial">
              <TriangleAlert size={13} /> Partial
            </span>
          )}
        </div>
        <ul className="coverage-list">
          {bundle.evidenceCoverage.length === 0 && (
            <li data-state="PARTIAL">
              <span className="coverage-source">Slack evidence</span>
              <span>Legacy coverage unavailable</span>
            </li>
          )}
          {bundle.evidenceCoverage.map((source) => (
            <li key={source.sourceId} data-state={source.state}>
              <span className="coverage-source">{source.sourceName}</span>
              <span>{coverageDetail(source)}</span>
            </li>
          ))}
          <li data-state="NOT_CONFIGURED">
            <span className="coverage-source">GitHub repository</span>
            <span>Not configured</span>
          </li>
        </ul>
      </section>
      <Tabs.Root
        className="evidence-tabs"
        value={activeTab}
        onValueChange={(value) => onTabChange(parseEvidenceTab(value))}
      >
        <Tabs.List
          className="evidence-tab-list"
          aria-label="Evidence categories"
        >
          <EvidenceTrigger
            value="questions"
            label="Questions"
            count={bundle.openQuestions.length}
          />
          <EvidenceTrigger
            value="claims"
            label="Claims"
            count={bundle.claims.length}
          />
          <EvidenceTrigger
            value="timeline"
            label="Timeline"
            count={bundle.timeline.length}
          />
          <EvidenceTrigger
            value="evidence"
            label="Sources"
            count={bundle.evidence.length}
          />
        </Tabs.List>
        <Tabs.Content className="evidence-tab-content" value="questions">
          {bundle.openQuestions.length === 0 ? (
            <TabEmpty
              icon={<CircleHelp />}
              title="No open questions"
              copy="The extraction did not leave any unresolved questions."
            />
          ) : (
            <QuestionReviewPanel
              editable={editable}
              evidence={bundle.evidence}
              onQuestionAnswerChange={onQuestionAnswerChange}
              questionAnswers={questionAnswers}
              questions={bundle.openQuestions}
            />
          )}
        </Tabs.Content>
        <Tabs.Content className="evidence-tab-content" value="claims">
          {bundle.claims.map((claim) => (
            <article
              className="evidence-card"
              id={`source-${claim.id}`}
              key={claim.id}
            >
              <div className="evidence-card-heading">
                <ClassificationBadge classification={claim.classification} />
                {claim.contradictingEvidenceIds.length > 0 && (
                  <span className="contradiction-flag">
                    <TriangleAlert size={13} /> Contradicted
                  </span>
                )}
              </div>
              <p>{claim.statement}</p>
              <div className="source-chip-row">
                {[
                  ...claim.supportingEvidenceIds,
                  ...claim.contradictingEvidenceIds,
                ].map((evidenceId) => (
                  <button
                    className="source-chip"
                    key={evidenceId}
                    onClick={(event) =>
                      onOpenSource(evidenceId, event.currentTarget)
                    }
                  >
                    <Link2 size={13} /> Evidence {shortId(evidenceId)}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </Tabs.Content>
        <Tabs.Content
          className="evidence-tab-content timeline-list"
          value="timeline"
        >
          {bundle.timeline.map((event) => (
            <article
              className="timeline-card"
              id={`source-${event.id}`}
              key={event.id}
            >
              <div className="timeline-dot" aria-hidden="true" />
              <time>{formatDateTime(event.occurredAt)}</time>
              <p>{event.summary}</p>
              <ClassificationBadge classification={event.classification} />
              <div className="source-chip-row">
                {event.evidenceIds.map((evidenceId) => (
                  <button
                    className="source-chip"
                    key={evidenceId}
                    onClick={(event) =>
                      onOpenSource(evidenceId, event.currentTarget)
                    }
                  >
                    <Link2 size={13} /> Evidence {shortId(evidenceId)}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </Tabs.Content>
        <Tabs.Content className="evidence-tab-content" value="evidence">
          {bundle.evidence.map((source) => {
            const sourceUrl = safeSourceUrl(source.sourceUri);
            return (
              <article
                className="source-card"
                id={`source-${source.id}`}
                key={source.id}
              >
                <div className="source-card-meta">
                  <span>{humanize(source.sourceType)}</span>
                  <time>{formatDateTime(source.occurredAt)}</time>
                </div>
                <p>{source.content}</p>
                <div className="source-card-footer">
                  {source.authorReference !== null && (
                    <span>Author {shortId(source.authorReference)}</span>
                  )}
                  {source.contentTruncated && (
                    <span className="truncated-flag">Content truncated</span>
                  )}
                  {sourceUrl !== null && (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Slack <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}

export function QuestionReviewPanel({
  editable,
  evidence = [],
  onQuestionAnswerChange,
  questionAnswers,
  questions,
}: {
  readonly editable: boolean;
  readonly evidence?: Bundle['evidence'];
  readonly onQuestionAnswerChange: (questionId: string, answer: string) => void;
  readonly questionAnswers: Readonly<Record<string, string>>;
  readonly questions: Bundle['openQuestions'];
}): ReactNode {
  const firstUnansweredQuestion = questions.find(
    (question) => (questionAnswers[question.id] ?? '').trim().length === 0,
  );
  const [activeQuestionId, setActiveQuestionId] = useState(
    firstUnansweredQuestion?.id ?? questions[0]?.id ?? null,
  );
  const activeQuestionIndex = questions.findIndex(
    (question) => question.id === activeQuestionId,
  );
  const answeredQuestionCount = Object.values(questionAnswers).filter(
    (answer) => answer.trim().length > 0,
  ).length;
  const [expandedEvidenceQuestionId, setExpandedEvidenceQuestionId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (questions.some((question) => question.id === activeQuestionId)) {
      return;
    }
    setActiveQuestionId(
      firstUnansweredQuestion?.id ?? questions[0]?.id ?? null,
    );
  }, [activeQuestionId, firstUnansweredQuestion?.id, questions]);

  return (
    <section className="question-review-panel" aria-label="Reviewer questions">
      <div className="question-progress" aria-live="polite">
        <span>
          <CircleHelp size={15} /> Reviewer context
        </span>
        <strong>
          {answeredQuestionCount} of {questions.length} answered
        </strong>
      </div>
      <div className="question-stepper" aria-label="Open questions">
        {questions.map((question, index) => {
          const answered =
            (questionAnswers[question.id] ?? '').trim().length > 0;
          const active = question.id === activeQuestionId;
          return (
            <button
              aria-current={active ? 'step' : undefined}
              aria-label={`Question ${index + 1}: ${answered ? 'answered' : 'needs answer'}`}
              className="question-step"
              data-answered={answered}
              data-active={active}
              key={question.id}
              onClick={() => setActiveQuestionId(question.id)}
              type="button"
            >
              {answered ? <Check size={13} /> : index + 1}
            </button>
          );
        })}
      </div>
      {questions.map((question, index) => {
        const answer = questionAnswers[question.id];
        if (answer === undefined) {
          throw new Error('Open question has no review state');
        }
        const answered = answer.trim().length > 0;
        const active = question.id === activeQuestionId;
        return (
          <article
            aria-hidden={!active}
            className="question-card"
            data-answered={answered}
            data-active={active}
            hidden={!active}
            key={question.id}
          >
            <header className="question-card-heading">
              <span>Question {String(index + 1).padStart(2, '0')}</span>
              <span className="question-answer-status">
                {answered ? <Check size={13} /> : <PencilLine size={13} />}
                {answered ? 'Answered' : 'Needs answer'}
              </span>
            </header>
            <p className="question-copy">{question.question}</p>
            {editable ? (
              <label className="question-answer-field">
                <span>Your reviewed answer</span>
                <textarea
                  aria-label={`Answer: ${question.question}`}
                  maxLength={4_000}
                  placeholder="Add the confirmed context, decision, or remaining uncertainty…"
                  rows={4}
                  value={answer}
                  onChange={(event) =>
                    onQuestionAnswerChange(question.id, event.target.value)
                  }
                />
                <small>{answer.length.toLocaleString()} / 4,000</small>
              </label>
            ) : (
              <div className="preserved-question-answer">
                <span>Reviewed answer</span>
                <p>
                  {answered
                    ? answer
                    : 'No answer was recorded in this revision.'}
                </p>
              </div>
            )}
            {question.evidenceIds.length > 0 && (
              <div className="question-evidence-disclosure">
                <button
                  aria-expanded={expandedEvidenceQuestionId === question.id}
                  className="question-evidence-button"
                  onClick={() =>
                    setExpandedEvidenceQuestionId((current) =>
                      current === question.id ? null : question.id,
                    )
                  }
                  type="button"
                >
                  <Link2 size={15} /> Evidence used for this question
                  <span>{question.evidenceIds.length}</span>
                  <ChevronDown size={15} />
                </button>
                {expandedEvidenceQuestionId === question.id && (
                  <section
                    aria-label={`Evidence for: ${question.question}`}
                    className="question-evidence-panel"
                  >
                    {question.evidenceIds.map((evidenceId) => {
                      const source = evidence.find(
                        (candidate) => candidate.id === evidenceId,
                      );
                      if (source === undefined) {
                        return (
                          <p
                            className="question-evidence-unavailable"
                            key={evidenceId}
                          >
                            This evidence is no longer available to the
                            reviewer.
                          </p>
                        );
                      }
                      const sourceUrl = safeSourceUrl(source.sourceUri);
                      return (
                        <article
                          className="question-evidence-card"
                          key={source.id}
                        >
                          <div>
                            <span>{humanize(source.sourceType)}</span>
                            <time>{formatDateTime(source.occurredAt)}</time>
                          </div>
                          <p>{source.content}</p>
                          {sourceUrl !== null && (
                            <a
                              href={sourceUrl}
                              rel="noopener noreferrer"
                              target="_blank"
                            >
                              Open original <ExternalLink size={13} />
                            </a>
                          )}
                        </article>
                      );
                    })}
                  </section>
                )}
              </div>
            )}
            <div className="question-navigation">
              <button
                className="question-navigation-button"
                disabled={activeQuestionIndex <= 0}
                onClick={() =>
                  setActiveQuestionId(
                    questions[activeQuestionIndex - 1]?.id ?? null,
                  )
                }
                type="button"
              >
                <ArrowLeft size={14} /> Previous
              </button>
              <button
                className="question-navigation-button question-navigation-next"
                disabled={activeQuestionIndex >= questions.length - 1}
                onClick={() =>
                  setActiveQuestionId(
                    questions[activeQuestionIndex + 1]?.id ?? null,
                  )
                }
                type="button"
              >
                Next question <ArrowRight size={14} />
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function coverageDetail(source: Bundle['evidenceCoverage'][number]): string {
  if (source.state === 'COMPLETE') {
    return `${source.messageCount} ${source.messageCount === 1 ? 'message' : 'messages'} collected`;
  }
  if (source.reason === 'REVIEWER_EXCLUDED' || source.state === 'EXCLUDED') {
    return 'Excluded by reviewer';
  }
  if (source.state === 'INACCESSIBLE') {
    return 'Access unavailable';
  }
  if (source.state === 'REVOKED') {
    return 'Authorization revoked';
  }
  if (source.state === 'PARTIAL') {
    return `${source.messageCount} messages collected · Partial`;
  }
  return source.reason?.toLowerCase().replaceAll('_', ' ') ?? source.state;
}

function EvidenceTrigger({
  count,
  label,
  value,
}: {
  readonly count: number;
  readonly label: string;
  readonly value: EvidenceTab;
}): ReactNode {
  return (
    <Tabs.Trigger className="evidence-tab-trigger" value={value}>
      {label}
      <span>{count}</span>
    </Tabs.Trigger>
  );
}

function ReviewActionBar({
  acknowledgedContradictions,
  acknowledgedQuestions,
  approveDisabled,
  busy,
  error,
  notice,
  onAcknowledgedContradictions,
  onAcknowledgedQuestions,
  onApprove,
  onSave,
}: {
  readonly acknowledgedContradictions: boolean;
  readonly acknowledgedQuestions: boolean;
  readonly approveDisabled: boolean;
  readonly busy: boolean;
  readonly error: unknown;
  readonly notice: string | null;
  readonly onAcknowledgedContradictions: (checked: boolean) => void;
  readonly onAcknowledgedQuestions: (checked: boolean) => void;
  readonly onApprove: () => void;
  readonly onSave: () => void;
}): ReactNode {
  return (
    <section
      className="review-action-bar"
      data-tour-target="approval"
      aria-labelledby="review-decision-title"
    >
      <div className="review-action-heading">
        <span className="action-icon">
          <FileCheck2 size={21} />
        </span>
        <div>
          <p className="eyebrow">Put it on record</p>
          <h2 id="review-decision-title">Complete this review</h2>
        </div>
      </div>
      <div className="acknowledgement-list">
        <Acknowledgement
          checked={acknowledgedContradictions}
          label="I reviewed material contradictions"
          onChange={onAcknowledgedContradictions}
        />
        <Acknowledgement
          checked={acknowledgedQuestions}
          label="I reviewed the open questions"
          onChange={onAcknowledgedQuestions}
        />
      </div>
      <div className="review-action-buttons">
        <button
          className="button button-secondary"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <History size={17} />
          )}
          Save revision
        </button>
        <button
          className="button button-primary"
          disabled={busy || approveDisabled}
          onClick={onApprove}
        >
          <BadgeCheck size={18} /> Approve record
        </button>
      </div>
      {(notice !== null || error !== null) && (
        <p
          className={
            error === null
              ? 'action-message action-success'
              : 'action-message action-error'
          }
          role="status"
        >
          {error === null ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertCircle size={16} />
          )}
          {error === null ? notice : userFacingError(error)}
        </p>
      )}
    </section>
  );
}

function Acknowledgement({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="acknowledgement">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="custom-checkbox" aria-hidden="true">
        <Check size={13} />
      </span>
      <span>{label}</span>
    </label>
  );
}

function AppFrame({
  children,
  compact = false,
  configuration,
  experience = 'production',
}: {
  readonly children: ReactNode;
  readonly compact?: boolean;
  readonly configuration: Configuration;
  readonly experience?: Experience;
}): ReactNode {
  return (
    <div className="app-surface" data-compact={compact}>
      <header className="app-header">
        <Brand />
        <div className="header-context">
          <span className="environment-indicator">
            <span />{' '}
            {experience === 'demo'
              ? 'Synthetic demo · no external effects'
              : 'Protected workspace'}
          </span>
          {experience !== 'demo' && (
            <a
              className="icon-button"
              href="#/settings/integrations"
              title="Workspace integrations"
            >
              <Settings2 size={18} aria-hidden="true" />
              <span className="sr-only">Workspace integrations</span>
            </a>
          )}
          <button
            className="icon-button"
            onClick={() =>
              experience === 'demo' ? location.reload() : signOut(configuration)
            }
            title={experience === 'demo' ? 'Reset demo' : 'Sign out'}
          >
            {experience === 'demo' ? (
              <RotateCcw size={18} aria-hidden="true" />
            ) : (
              <LogOut size={18} aria-hidden="true" />
            )}
            <span className="sr-only">
              {experience === 'demo' ? 'Reset demo' : 'Sign out'}
            </span>
          </button>
        </div>
      </header>
      {children}
      <footer className="app-footer">
        <span>
          <ShieldCheck size={15} />{' '}
          {experience === 'demo'
            ? 'Synthetic data · browser-memory state'
            : 'Tenant-authorized evidence review'}
        </span>
        <span>OnRecord</span>
      </footer>
    </div>
  );
}

function Brand({ light = false }: { readonly light?: boolean }): ReactNode {
  return (
    <a
      className="brand"
      data-light={light}
      href="#/"
      aria-label="OnRecord home"
    >
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="brand-copy">
        <strong>OnRecord</strong>
        <small>Incident Review</small>
      </span>
    </a>
  );
}

function MetricCard({
  icon,
  label,
  tone,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly tone: 'amber' | 'blue' | 'green' | 'violet';
  readonly value: number;
}): ReactNode {
  return (
    <article className="metric-card" data-tone={tone}>
      <span className="metric-icon">{icon}</span>
      <span>
        <strong>{value}</strong>
        <small>{label}</small>
      </span>
    </article>
  );
}

function CompactMetric({
  icon,
  label,
  value,
  warning = false,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: number;
  readonly warning?: boolean;
}): ReactNode {
  return (
    <article className="compact-metric" data-warning={warning}>
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </article>
  );
}

function Fact({
  label,
  value,
  warning = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly warning?: boolean;
}): ReactNode {
  return (
    <span className="fact" data-warning={warning}>
      <strong>{value}</strong> {label}
    </span>
  );
}

function StatusPill({
  status,
}: {
  readonly status: 'APPROVED' | 'NEEDS_REVIEW';
}): ReactNode {
  return (
    <span className="status-pill" data-status={status}>
      {status === 'APPROVED' ? (
        <CheckCircle2 size={13} />
      ) : (
        <Clock3 size={13} />
      )}
      {status === 'APPROVED' ? 'Approved' : 'Needs review'}
    </span>
  );
}

function ClassificationBadge({
  classification,
}: {
  readonly classification: Classification;
}): ReactNode {
  return (
    <span
      className="classification-badge"
      data-classification={classification}
      title={classificationDescription(classification)}
    >
      <span aria-hidden="true" />
      {humanize(classification)}
    </span>
  );
}

function TabEmpty({
  copy,
  icon,
  title,
}: {
  readonly copy: string;
  readonly icon: ReactNode;
  readonly title: string;
}): ReactNode {
  return (
    <div className="tab-empty">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

function EmptyInbox({
  hasIncidents,
}: {
  readonly hasIncidents: boolean;
}): ReactNode {
  return (
    <div className="empty-inbox">
      <span>
        <BookOpenText size={25} />
      </span>
      <h3>
        {hasIncidents
          ? 'No incidents match this view'
          : 'Your review queue is clear'}
      </h3>
      <p>
        {hasIncidents
          ? 'Try another status or search term.'
          : 'New incident records will appear here when they are ready for review.'}
      </p>
    </div>
  );
}

function PageLoading({ label }: { readonly label: string }): ReactNode {
  return (
    <main className="loading-screen" aria-live="polite">
      <Brand />
      <div className="loading-orbit" aria-hidden="true">
        <span />
        <span />
      </div>
      <p>
        {label}
        <span className="loading-dots">…</span>
      </p>
    </main>
  );
}

function RequestFailure({
  back = false,
  error,
  onRetry,
}: {
  readonly back?: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="error-state mx-auto max-w-xl">
        <div className="error-icon">
          <AlertCircle size={24} />
        </div>
        <p className="eyebrow">Review unavailable</p>
        <h1>We could not load this workspace.</h1>
        <p>{userFacingError(error)}</p>
        <div className="flex flex-wrap gap-3">
          {back && (
            <button
              className="button button-secondary"
              onClick={() => {
                location.hash = '#/';
              }}
            >
              <ArrowLeft size={17} /> Back to inbox
            </button>
          )}
          <button className="button button-primary" onClick={onRetry}>
            Try again <ArrowRight size={17} />
          </button>
        </div>
      </div>
    </main>
  );
}

function createStatementStates(
  bundle: Bundle,
  revisionStatements = bundle.latestRevision?.statements ?? null,
): Readonly<Record<string, StatementState>> {
  const sources = bundle.sections.flatMap((section) => section.statements);
  const views = reconcileRevisionStatements(sources, revisionStatements);
  return Object.fromEntries(
    sources.map((statement) => {
      const view = views.get(statement.id);
      if (view === undefined) {
        throw new Error('Report statement has no display decision');
      }
      return [
        statement.id,
        {
          decision: view.decision,
          text: view.text,
          classification: parseClassification(view.classification),
        },
      ];
    }),
  );
}

function createQuestionAnswerStates(
  bundle: Bundle,
  revisionAnswers = bundle.latestRevision?.questionAnswers ?? null,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    reconcileRevisionQuestionAnswers(bundle.openQuestions, revisionAnswers),
  );
}

function createAdditionalStatementStates(
  revision: RevisionDetail | null,
): readonly AdditionalStatementState[] {
  if (revision === null) return [];
  return revision.statements.flatMap((statement) =>
    statement.decision !== 'ADD' ||
    statement.text === null ||
    statement.classification === null
      ? []
      : [
          {
            clientStatementId: crypto.randomUUID(),
            sectionType: statement.sectionType,
            text: statement.text,
            classification: parseClassification(statement.classification),
            claimIds: statement.claimIds,
            timelineEventIds: statement.timelineEventIds,
          },
        ],
  );
}

function sourceSummary(
  source: Bundle['claims'][number] | Bundle['timeline'][number],
): string {
  return 'statement' in source ? source.statement : source.summary;
}

function classificationCaution(classification: Classification): number {
  switch (classification) {
    case 'human_confirmed':
    case 'directly_observed':
    case 'corroborated':
      return 0;
    case 'participant_assertion':
      return 1;
    case 'correlated_inference':
      return 2;
    case 'hypothesis':
      return 3;
    case 'disputed':
      return 4;
    case 'unknown':
      return 5;
  }
}

function mostCautiousClassification(
  classifications: readonly Classification[],
): Classification | null {
  return classifications.reduce<Classification | null>(
    (mostCautious, classification) =>
      mostCautious === null ||
      classificationCaution(classification) >
        classificationCaution(mostCautious)
        ? classification
        : mostCautious,
    null,
  );
}

function formatCalendarDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function parseClassification(value: string): Classification {
  const parsed = classificationValues.find((candidate) => candidate === value);
  if (parsed === undefined) {
    throw new Error('Unsupported evidence classification');
  }
  return parsed;
}

function parseEvidenceTab(value: string): EvidenceTab {
  if (
    value === 'questions' ||
    value === 'claims' ||
    value === 'timeline' ||
    value === 'evidence'
  ) {
    return value;
  }
  throw new Error('Unsupported evidence tab');
}

function sourceTab(bundle: Bundle, id: string): EvidenceTab {
  if (bundle.claims.some((claim) => claim.id === id)) return 'claims';
  if (bundle.timeline.some((event) => event.id === id)) return 'timeline';
  return 'evidence';
}

function userFacingError(error: unknown): string {
  if (error instanceof AuthenticationExpiredError) {
    return 'Your secure session expired. Sign in again to continue.';
  }
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return 'The request was invalid. Check every decision and acknowledgement.';
      case 403:
        return 'Your account does not have permission to perform this workspace action.';
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

function classificationDescription(classification: Classification): string {
  switch (classification) {
    case 'directly_observed':
      return 'Directly visible in the collected evidence';
    case 'corroborated':
      return 'Supported by multiple independent evidence items';
    case 'participant_assertion':
      return 'Stated by an incident participant';
    case 'hypothesis':
      return 'A possible explanation that remains unconfirmed';
    case 'correlated_inference':
      return 'Correlated evidence, not established causation';
    case 'disputed':
      return 'Conflicting evidence or participant accounts exist';
    case 'unknown':
      return 'The available evidence does not establish this';
    case 'human_confirmed':
      return 'Explicitly confirmed by a human reviewer';
  }
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./u, (letter) => letter.toUpperCase());
}

function severityTone(severity: string): string {
  const normalized = severity.toUpperCase();
  if (normalized.includes('1') || normalized.includes('CRITICAL'))
    return 'critical';
  if (normalized.includes('2') || normalized.includes('HIGH')) return 'high';
  return 'standard';
}

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 6)}…${id.slice(-3)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const milliseconds = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
