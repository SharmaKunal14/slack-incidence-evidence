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
  ChevronRight,
  CircleHelp,
  Clock3,
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
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  Component,
  useEffect,
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
  revisionResponseSchema,
  type Bundle,
  type Classification,
  type Configuration,
  type InboxItem,
  type Statement,
} from './contracts.js';
import { reconcileRevisionStatements } from './revision-view.js';
import { safeSourceUrl } from './safe-source-url.js';

type InboxFilter = 'ALL' | 'NEEDS_REVIEW' | 'APPROVED';
type EvidenceTab = 'questions' | 'claims' | 'timeline' | 'evidence';
type ReviewDecision = 'KEEP' | 'EDIT' | 'EXCLUDE';

export interface StatementState {
  readonly decision: ReviewDecision;
  readonly text: string;
  readonly classification: Classification;
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
}: {
  readonly configuration: Configuration;
}): ReactNode {
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
  return (
    <ApplicationErrorBoundary>
      {incidentMatch?.[1] === undefined ? (
        <InboxPage configuration={configuration} token={token} />
      ) : (
        <IncidentPage
          configuration={configuration}
          incidentId={incidentMatch[1]}
          token={token}
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
        <h1>The review console needs a moment.</h1>
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
          <p className="eyebrow eyebrow-light">Incident Evidence Copilot</p>
          <h1 id="auth-story-title">Every conclusion, traceable.</h1>
          <p>
            Turn fragmented incident conversations into a reviewed postmortem
            without losing the evidence, uncertainty, or human judgment behind
            it.
          </p>
          <div className="auth-proof" aria-label="Product safeguards">
            <span>
              <ShieldCheck size={17} /> Evidence linked
            </span>
            <span>
              <BadgeCheck size={17} /> Human approved
            </span>
            <span>
              <History size={17} /> Revision preserved
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
          <h2 id="sign-in-title">Continue to incident review</h2>
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
  configuration,
  token,
}: {
  readonly configuration: Configuration;
  readonly token: string;
}): ReactNode {
  const [filter, setFilter] = useState<InboxFilter>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const query = useQuery({
    queryKey: ['review-inbox'],
    queryFn: async () =>
      inboxSchema.parse(
        await apiRequest(configuration, token, '/review/incidents?limit=50'),
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
    <AppFrame configuration={configuration}>
      <main className="page-shell">
        <section className="inbox-hero reveal">
          <div>
            <p className="eyebrow">Review workspace</p>
            <h1>Make the incident record trustworthy.</h1>
            <p className="hero-copy">
              Inspect evidence, challenge uncertain claims, and preserve every
              human correction before a report can move forward.
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
              <h2>Postmortems</h2>
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
  configuration,
  incidentId,
  token,
}: {
  readonly configuration: Configuration;
  readonly incidentId: string;
  readonly token: string;
}): ReactNode {
  const query = useQuery({
    queryKey: ['incident-review', incidentId],
    queryFn: async () =>
      bundleSchema.parse(
        await apiRequest(
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
    <AppFrame configuration={configuration} compact>
      <IncidentWorkspace
        bundle={query.data}
        configuration={configuration}
        token={token}
      />
    </AppFrame>
  );
}

function IncidentWorkspace({
  bundle,
  configuration,
  token,
}: {
  readonly bundle: Bundle;
  readonly configuration: Configuration;
  readonly token: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<EvidenceTab>('questions');
  const [statementStates, setStatementStates] = useState(() =>
    createStatementStates(bundle),
  );
  const [acknowledgedContradictions, setAcknowledgedContradictions] = useState(
    bundle.latestRevision?.acknowledgedContradictions ?? false,
  );
  const [acknowledgedQuestions, setAcknowledgedQuestions] = useState(
    bundle.latestRevision?.acknowledgedOpenQuestions ?? false,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const revisionIdentity = bundle.latestRevision?.id ?? bundle.reportDraft.id;

  useEffect(() => {
    setStatementStates(createStatementStates(bundle));
    setAcknowledgedContradictions(
      bundle.latestRevision?.acknowledgedContradictions ?? false,
    );
    setAcknowledgedQuestions(
      bundle.latestRevision?.acknowledgedOpenQuestions ?? false,
    );
  }, [bundle, revisionIdentity]);

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
      return revisionResponseSchema.parse(
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
              acknowledgedContradictions,
              acknowledgedOpenQuestions: acknowledgedQuestions,
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
    bundle.latestRevision?.status === 'DRAFT' ? bundle.latestRevision : null;
  const approveRevision = useMutation({
    mutationFn: async () => {
      if (displayedDraft === null) {
        throw new Error('No displayed draft is available for approval');
      }
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
    },
    onSuccess: async () => {
      setNotice('The reviewed revision is now approved.');
      await queryClient.invalidateQueries({
        queryKey: ['incident-review', bundle.incident.id],
      });
      await queryClient.invalidateQueries({ queryKey: ['review-inbox'] });
    },
  });

  const editable = bundle.incident.status === 'NEEDS_REVIEW';
  const contradictionCount = bundle.claims.filter(
    (claim) =>
      claim.classification === 'disputed' ||
      claim.contradictingEvidenceIds.length > 0,
  ).length;
  const busy = saveRevision.isPending || approveRevision.isPending;
  const operationError = saveRevision.error ?? approveRevision.error;

  const openSource = (id: string): void => {
    const targetTab = sourceTab(bundle, id);
    setActiveTab(targetTab);
    window.setTimeout(() => highlightSource(id), 0);
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
      </nav>

      <section className="incident-hero reveal reveal-delay-one">
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
            {bundle.latestRevision === null ? (
              <>
                <Sparkles size={16} /> Original AI draft{' '}
                {bundle.reportDraft.draftVersion}
              </>
            ) : (
              <>
                <History size={16} /> Human revision{' '}
                {bundle.latestRevision.revisionNumber} ·{' '}
                {humanize(bundle.latestRevision.status)}
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
        <section className="report-workspace" aria-labelledby="report-title">
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">Reviewed narrative</p>
              <h2 id="report-title">Postmortem draft</h2>
            </div>
            <span className="workspace-hint">
              <ShieldCheck size={15} /> Every statement stays linked to its
              source
            </span>
          </div>
          <div className="report-sections">
            {bundle.sections.map((section, sectionIndex) => (
              <section className="report-section" key={section.sectionType}>
                <header className="report-section-heading">
                  <span>{String(sectionIndex + 1).padStart(2, '0')}</span>
                  <h3>{humanize(section.sectionType)}</h3>
                  <small>
                    {section.statements.length}{' '}
                    {section.statements.length === 1
                      ? 'statement'
                      : 'statements'}
                  </small>
                </header>
                <div className="statement-list">
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
                </div>
              </section>
            ))}
          </div>
        </section>

        <EvidenceWorkspace
          activeTab={activeTab}
          bundle={bundle}
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
          onSave={() => saveRevision.mutate()}
        />
      ) : (
        <section
          className="approved-banner reveal"
          aria-label="Approved revision"
        >
          <span>
            <CheckCircle2 size={22} />
          </span>
          <div>
            <strong>Approved revision locked</strong>
            <p>This immutable human-reviewed record is displayed read-only.</p>
          </div>
        </section>
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
  readonly onOpenSource: (id: string) => void;
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
              onClick={() => onOpenSource(sourceId)}
            >
              <Link2 size={13} aria-hidden="true" /> Source {shortId(sourceId)}
            </button>
          ),
        )}
      </div>
    </article>
  );
}

function EvidenceWorkspace({
  activeTab,
  bundle,
  onOpenSource,
  onTabChange,
}: {
  readonly activeTab: EvidenceTab;
  readonly bundle: Bundle;
  readonly onOpenSource: (id: string) => void;
  readonly onTabChange: (tab: EvidenceTab) => void;
}): ReactNode {
  return (
    <aside className="evidence-workspace" aria-labelledby="evidence-title">
      <div className="workspace-heading evidence-heading">
        <div>
          <p className="eyebrow">Source of truth</p>
          <h2 id="evidence-title">Evidence explorer</h2>
        </div>
        <span className="evidence-total">{bundle.evidence.length} sources</span>
      </div>
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
            bundle.openQuestions.map((question, index) => (
              <article className="question-card" key={question.id}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{question.question}</p>
              </article>
            ))
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
                    onClick={() => onOpenSource(evidenceId)}
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
                    onClick={() => onOpenSource(evidenceId)}
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
      aria-labelledby="review-decision-title"
    >
      <div className="review-action-heading">
        <span className="action-icon">
          <FileCheck2 size={21} />
        </span>
        <div>
          <p className="eyebrow">Human checkpoint</p>
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
          <BadgeCheck size={18} /> Approve revision
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
}: {
  readonly children: ReactNode;
  readonly compact?: boolean;
  readonly configuration: Configuration;
}): ReactNode {
  return (
    <div className="app-surface" data-compact={compact}>
      <header className="app-header">
        <Brand />
        <div className="header-context">
          <span className="environment-indicator">
            <span /> Protected workspace
          </span>
          <button
            className="icon-button"
            onClick={() => signOut(configuration)}
            title="Sign out"
          >
            <LogOut size={18} aria-hidden="true" />
            <span className="sr-only">Sign out</span>
          </button>
        </div>
      </header>
      {children}
      <footer className="app-footer">
        <span>
          <ShieldCheck size={15} /> Tenant-authorized evidence review
        </span>
        <span>Incident Evidence Copilot</span>
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
      aria-label="Incident Evidence Copilot home"
    >
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="brand-copy">
        <strong>Incident Copilot</strong>
        <small>Evidence Review</small>
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
          : 'New evidence-backed drafts will appear here when they are ready.'}
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
): Readonly<Record<string, StatementState>> {
  const sources = bundle.sections.flatMap((section) => section.statements);
  const views = reconcileRevisionStatements(
    sources,
    bundle.latestRevision?.statements ?? null,
  );
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

function highlightSource(id: string): void {
  const source = document.getElementById(`source-${id}`);
  if (source === null) return;
  source.classList.add('highlight');
  source.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
    block: 'center',
  });
  window.setTimeout(() => source.classList.remove('highlight'), 2_000);
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
