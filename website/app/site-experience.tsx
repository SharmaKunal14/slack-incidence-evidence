"use client";

import { Fragment, useEffect, useState, type CSSProperties } from "react";

const demoHref = "/review-demo/demo.html";

const workflow = [
  {
    step: "01",
    title: "Scope the incident",
    copy: "Choose the exact Slack channels, time window, threads, and reviewer. Nothing is searched in the background.",
  },
  {
    step: "02",
    title: "Build the evidence graph",
    copy: "Messages become cited timeline events, claims, contradictions, and questions—not a loose prompt transcript.",
  },
  {
    step: "03",
    title: "Review every conclusion",
    copy: "Keep, edit, exclude, or reclassify each statement while the source evidence stays beside it.",
  },
  {
    step: "04",
    title: "Approve one record",
    copy: "Only a human-approved immutable revision can be published to Confluence or Notion.",
  },
] as const;

const principles = [
  ["Evidence before prose", "The draft is generated from structured, cited claims—not directly from raw conversation."],
  ["Uncertainty stays visible", "Hypotheses, disputes, partial coverage, and unanswered questions cannot be polished away."],
  ["Approval means something", "The model cannot confirm a cause, approve a revision, or create an external effect."],
] as const;

const productProof = [
  {
    index: "01",
    eyebrow: "Slack intake",
    title: "Scope what the system is allowed to see.",
    copy: "A signed Slack shortcut opens a bounded scoping flow: time window, one primary public channel, up to four additional public channels, optional thread anchors, and a named reviewer.",
    status: "Implemented · requires connected Slack",
  },
  {
    index: "02",
    eyebrow: "Evidence pipeline",
    title: "Create the record before writing the story.",
    copy: "Collection is checkpointed. Analysis persists cited timeline events, claims, contradictions, questions, source coverage, model metadata, and token usage before report generation begins.",
    status: "Implemented · synthetic demo data",
  },
  {
    index: "03",
    eyebrow: "Human review",
    title: "Use the same interface reviewers use.",
    copy: "The public demo is a production build of the real review console—not a marketing recreation. Only its API boundary is replaced with validated, in-memory synthetic incident data.",
    status: "Live in this demo",
  },
  {
    index: "04",
    eyebrow: "Controlled publication",
    title: "Publish exactly what was approved.",
    copy: "Approval locks one immutable revision and queues retry-safe publication through configured Confluence or Notion adapters, followed by a final Slack notification.",
    status: "Implemented · external effects disabled here",
  },
] as const;

const capabilityGroups = [
  {
    status: "Implemented",
    tone: "implemented",
    description: "Code and focused automated tests exist in the product repository.",
    visual: {
      src: "/proof/review-overview.jpg",
      alt: "The production OnRecord review console showing the EU checkout outage, evidence counts, report, and evidence explorer.",
      caption: "Production review console · synthetic incident",
    },
    items: [
      "Signed Slack trigger and incident-scoping modal",
      "Multi-channel collection, thread expansion, and coverage manifest",
      "Structured claims, timeline, contradictions, and open questions",
      "Evidence-constrained report generation and citation validation",
      "Authenticated review console with immutable revision history",
      "Human approval and Confluence or Notion publication adapters",
    ],
  },
  {
    status: "Proven here",
    tone: "demoed",
    description: "The production review UI runs against constrained synthetic state.",
    visual: {
      src: "/proof/evidence-review.jpg",
      alt: "The OnRecord evidence review interface showing cited statements, reviewer decisions, source coverage, and claims.",
      caption: "Real reviewer controls · safe browser-memory state",
    },
    items: [
      "Inspect claims, timeline events, evidence, and source coverage",
      "Keep, edit, exclude, or add evidence-linked statements",
      "Answer open questions and acknowledge contradictions",
      "Save a revision, approve it, and inspect the read-only result",
    ],
  },
  {
    status: "Customer setup",
    tone: "configured",
    description: "Implemented paths that still require a provisioned customer environment.",
    visual: null,
    items: [
      "Slack app installation and approved workspace scopes",
      "AWS, PostgreSQL, Cognito, networking, and runtime secrets",
      "A destination Confluence space or private Notion data source",
      "Operational ownership for retention, alarms, and deployment promotion",
    ],
  },
  {
    status: "Future work",
    tone: "planned",
    description: "Explicit roadmap—not represented as available product functionality.",
    visual: null,
    items: [
      "Slack OAuth installation and token lifecycle management",
      "GitHub App evidence collection",
      "Enforced retention-deletion jobs",
      "Action-item creation and semantic quality benchmarking",
    ],
  },
] as const;

type TechnologyIconSpec = {
  readonly kind: "asset";
  readonly src: string;
  readonly alt: string;
  readonly dark?: boolean;
};

const awsIcon = (filename: string, service: string): TechnologyIconSpec => ({
  kind: "asset",
  src: `/tech/aws/${filename}`,
  alt: `${service} official architecture icon`,
});

const brandIcon = (slug: string, brand: string): TechnologyIconSpec => ({
  kind: "asset",
  src: `/tech/brands/${slug}.svg`,
  alt: `${brand} logo`,
});

const openAiIcon: TechnologyIconSpec = {
  kind: "asset",
  src: "/tech/openai-blossom.svg",
  alt: "OpenAI Blossom",
  dark: true,
};

const slackIcon: TechnologyIconSpec = {
  kind: "asset",
  src: "/tech/slack-official.png",
  alt: "Slack official logo",
};

const stackGroups = [
  {
    label: "Experience",
    items: [
      { name: "React 19", icon: brandIcon("react", "React") },
      { name: "TypeScript", icon: brandIcon("typescript", "TypeScript") },
      { name: "TanStack Query", icon: brandIcon("tanstack", "TanStack") },
      { name: "Radix UI", icon: brandIcon("radixui", "Radix UI") },
      { name: "Amazon Cognito", icon: awsIcon("Arch_Amazon-Cognito_64.png", "Amazon Cognito") },
    ],
  },
  {
    label: "Evidence + AI",
    items: [
      { name: "OpenAI Responses API", icon: openAiIcon },
      { name: "Zod schemas", icon: brandIcon("zod", "Zod") },
      { name: "PostgreSQL", icon: brandIcon("postgresql", "PostgreSQL") },
      { name: "AWS Secrets Manager", icon: awsIcon("Arch_AWS-Secrets-Manager_64.png", "AWS Secrets Manager") },
    ],
  },
  {
    label: "Workflow",
    items: [
      { name: "API Gateway", icon: awsIcon("Arch_Amazon-API-Gateway_64.png", "Amazon API Gateway") },
      { name: "AWS Lambda", icon: awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda") },
      { name: "SQS FIFO + DLQ", icon: awsIcon("Arch_Amazon-Simple-Queue-Service_64.png", "Amazon SQS") },
      { name: "Step Functions", icon: awsIcon("Arch_AWS-Step-Functions_64.png", "AWS Step Functions") },
      { name: "EventBridge", icon: awsIcon("Arch_Amazon-EventBridge_64.png", "Amazon EventBridge") },
    ],
  },
  {
    label: "Delivery + release",
    items: [
      { name: "Amazon S3", icon: awsIcon("Arch_Amazon-Simple-Storage-Service_64.png", "Amazon S3") },
      { name: "CloudFront", icon: awsIcon("Arch_Amazon-CloudFront_64.png", "Amazon CloudFront") },
      { name: "Terraform", icon: brandIcon("terraform", "Terraform") },
      { name: "GitHub Actions", icon: brandIcon("githubactions", "GitHub Actions") },
      { name: "Confluence", icon: brandIcon("confluence", "Confluence") },
      { name: "Notion", icon: brandIcon("notion", "Notion") },
    ],
  },
] as const;

type JourneyNode = {
  readonly title: string;
  readonly detail: string;
  readonly icons: readonly TechnologyIconSpec[];
  readonly tone?: "external" | "aws" | "record" | "human" | "destination";
};

const journeyLanes: readonly {
  label: string;
  title: string;
  startDelay: number;
  nodes: readonly JourneyNode[];
}[] = [
  {
    label: "01 · Intake",
    title: "Accept the event durably",
    startDelay: 0,
    nodes: [
      { title: "Slack event", detail: "Raw signed HTTP request", icons: [slackIcon], tone: "external" },
      { title: "API Gateway", detail: "Public webhook boundary", icons: [awsIcon("Arch_Amazon-API-Gateway_64.png", "Amazon API Gateway")], tone: "aws" },
      { title: "Ingress Lambda", detail: "HMAC + replay verification", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "SQS FIFO", detail: "Durable, deduplicated command", icons: [awsIcon("Arch_Amazon-Simple-Queue-Service_64.png", "Amazon SQS")], tone: "aws" },
      { title: "Worker Lambda", detail: "Idempotent incident start", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "Step Functions", detail: "Deterministic orchestration", icons: [awsIcon("Arch_AWS-Step-Functions_64.png", "AWS Step Functions")], tone: "aws" },
    ],
  },
  {
    label: "02 · Evidence pipeline",
    title: "Collect, structure, and draft",
    startDelay: 4.1,
    nodes: [
      { title: "Collector Lambda", detail: "Bounded Slack history pages", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "Slack Web API", detail: "Approved channels + threads", icons: [slackIcon], tone: "external" },
      { title: "Evidence store", detail: "Atomic PostgreSQL checkpoints", icons: [brandIcon("postgresql", "PostgreSQL")], tone: "record" },
      { title: "Analysis Lambda", detail: "OpenAI structured extraction", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "Report Lambda", detail: "Source-linked draft + validation", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "Notify Lambda", detail: "Content-free review-ready link", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
    ],
  },
  {
    label: "03 · Human gate + publication",
    title: "Review, approve, then publish",
    startDelay: 8.2,
    nodes: [
      { title: "Review console", detail: "S3 origin through CloudFront", icons: [awsIcon("Arch_Amazon-Simple-Storage-Service_64.png", "Amazon S3"), awsIcon("Arch_Amazon-CloudFront_64.png", "Amazon CloudFront")], tone: "human" },
      { title: "Amazon Cognito", detail: "Authorization code + PKCE", icons: [awsIcon("Arch_Amazon-Cognito_64.png", "Amazon Cognito")], tone: "aws" },
      { title: "Review API Lambda", detail: "JWT + membership authorization", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "Approved revision", detail: "PostgreSQL transaction + outbox", icons: [brandIcon("postgresql", "PostgreSQL")], tone: "record" },
      { title: "EventBridge", detail: "Bounded publication schedule", icons: [awsIcon("Arch_Amazon-EventBridge_64.png", "Amazon EventBridge")], tone: "aws" },
      { title: "Publisher Lambda", detail: "Leased, retry-safe side effects", icons: [awsIcon("Arch_AWS-Lambda_64.png", "AWS Lambda")], tone: "aws" },
      { title: "Final destinations", detail: "Confluence or Notion + Slack", icons: [brandIcon("confluence", "Confluence"), brandIcon("notion", "Notion"), slackIcon], tone: "destination" },
    ],
  },
];

function TechnologyIcon({ spec }: { spec: TechnologyIconSpec }) {
  return (
    <span className="technology-icon" data-dark={spec.dark || undefined}>
      {/* Official vendor assets are stored locally and served without a runtime optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={spec.src} alt={spec.alt} width={64} height={64} loading="lazy" decoding="async" />
    </span>
  );
}

function ArchitectureNode({ node, delay }: { node: JourneyNode; delay: number }) {
  return (
    <article className="journey-node" data-tone={node.tone} style={{ "--node-delay": `${delay}s` } as CSSProperties}>
      <div className="journey-node-icons">{node.icons.map((icon, index) => <TechnologyIcon key={`${node.title}-${index}`} spec={icon} />)}</div>
      <h4>{node.title}</h4>
      <p>{node.detail}</p>
      <span className="journey-node-state" aria-hidden="true"><i /> received</span>
    </article>
  );
}

function ArchitectureJourney() {
  return (
    <section className="architecture-section section-pad" id="architecture">
      <div className="shell">
        <div className="architecture-heading" data-reveal>
          <div><p className="kicker kicker-light">Live system journey</p><h3>Watch one event become an approved record.</h3></div>
          <p>The moving packet follows the implemented production path. It pauses at the human gate because infrastructure can prepare a record, but it cannot approve one.</p>
        </div>
        <div className="architecture-map" data-reveal aria-label="Animated OnRecord system journey from Slack through AWS infrastructure to approved publication">
          <div className="journey-live"><i /><span>Tracing event · incident.review.requested</span><b>Synthetic animation</b></div>
          {journeyLanes.map((lane, laneIndex) => (
            <Fragment key={lane.label}>
              <section className="journey-lane">
                <div className="journey-lane-heading"><span>{lane.label}</span><h4>{lane.title}</h4></div>
                <div className="journey-scroll">
                  <div className="journey-track">
                    {lane.nodes.map((node, nodeIndex) => {
                      const delay = lane.startDelay + nodeIndex * 0.62;
                      return (
                        <Fragment key={`${lane.label}-${node.title}`}>
                          <ArchitectureNode node={node} delay={delay} />
                          {nodeIndex < lane.nodes.length - 1 ? (
                            <span className="journey-link" style={{ "--flow-delay": `${delay + 0.25}s` } as CSSProperties} aria-hidden="true">
                              <i /><b>event</b>
                            </span>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              </section>
              {laneIndex < journeyLanes.length - 1 ? (
                <div className="journey-handoff" style={{ "--flow-delay": `${journeyLanes[laneIndex + 1].startDelay - 0.55}s` } as CSSProperties} aria-hidden="true">
                  <span>workflow continues</span><i />
                </div>
              ) : null}
            </Fragment>
          ))}
          <div className="architecture-legend">
            <span><i data-tone="external" /> External boundary</span>
            <span><i data-tone="aws" /> AWS runtime</span>
            <span><i data-tone="record" /> Durable record</span>
            <span><i data-tone="human" /> Human authority</span>
          </div>
        </div>
        <p className="architecture-footnote" data-reveal>Secrets Manager supplies scoped runtime credentials to the relevant Lambdas and is intentionally shown outside the event path: secrets configure execution; incident payloads do not travel through it.</p>
      </div>
    </section>
  );
}

function ProductWorkspace() {
  return (
    <section className="product-section section-pad" id="product">
      <div className="shell product-shell">
        <div className="product-copy" data-reveal>
          <p className="kicker kicker-light">The actual review workspace</p>
          <h2>This is product code, not a product rendering.</h2>
          <p>
            The window beside this copy loads the same React application used
            by the authenticated review console. The public demo swaps only
            the API boundary for validated synthetic state.
          </p>
          <div className="product-proof-note">
            <span><i /> Real console components</span>
            <span><i /> Synthetic evidence</span>
            <span><i /> External effects blocked</span>
          </div>
          <a className="button button-ivory" href={demoHref}>Use the actual interface <span aria-hidden="true">→</span></a>
        </div>
        <div className="product-window product-window-live" data-reveal>
          <div className="window-bar"><span className="window-mark">OR</span><span>Production review UI · synthetic API</span><div><i /><i /><i /></div></div>
          <iframe
            src="/review-demo/demo.html"
            title="Preview of the OnRecord review console"
            loading="lazy"
            sandbox="allow-scripts allow-same-origin"
            tabIndex={-1}
          />
          <a className="product-window-overlay" href={demoHref} aria-label="Open the full interactive product demo">
            <span>Open interactive product <b aria-hidden="true">↗</b></span>
          </a>
        </div>
      </div>
    </section>
  );
}

function WorkflowWalkthrough() {
  return (
    <section className="walkthrough-section section-pad" id="walkthrough">
      <div className="shell">
        <div className="walkthrough-heading" data-reveal>
          <div>
            <p className="kicker">90-second product walkthrough</p>
            <h2>Watch one incident travel from Slack to an approved Confluence record.</h2>
          </div>
          <p>
            Recorded in a connected test environment with synthetic incident
            data. Processing and review sequences are visibly accelerated; the
            approval and publication path is real.
          </p>
        </div>
        <figure className="walkthrough-frame" data-reveal>
          <div className="walkthrough-topline">
            <span><i /> Connected test environment</span>
            <span>02:00 · Slack to Confluence</span>
          </div>
          <div className="walkthrough-video">
            <video
              controls
              playsInline
              preload="metadata"
              poster="/video/onrecord-workflow-poster.jpg"
              aria-label="OnRecord workflow from Slack incident scoping through human approval and Confluence publication"
            >
              <source src="/video/onrecord-workflow-120s.mp4" type="video/mp4" />
              <track
                kind="captions"
                src="/video/onrecord-workflow-120s.vtt"
                srcLang="en"
                label="English workflow captions"
              />
              Your browser does not support embedded video.
            </video>
          </div>
          <figcaption>
            <span>Slack intake</span><i /><span>AWS evidence pipeline</span><i />
            <span>Human review</span><i /><span>Approved publication</span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function ImplementationStack() {
  return (
    <section className="implementation-section section-pad" id="stack">
      <div className="shell">
        <div className="method-stack">
          <div className="method-stack-heading" data-reveal>
            <div><p className="kicker">The implementation stack</p><h3>Technology chosen for durable evidence, not demo theatre.</h3></div>
            <p>These technologies are present in the repository. Customer infrastructure still requires explicit provisioning.</p>
          </div>
          <div className="stack-grid">
            {stackGroups.map((group, index) => (
              <article key={group.label} data-reveal style={{ "--stack-delay": `${index * 70}ms` } as CSSProperties}>
                <div className="stack-group-heading"><span>0{index + 1}</span><h4>{group.label}</h4></div>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.name}><TechnologyIcon spec={item.icon} /><span>{item.name}</span></li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <p className="stack-note" data-reveal>Brand marks identify the technologies used; they do not imply vendor endorsement. AWS service artwork is from the current AWS-approved architecture icon set.</p>
        </div>
      </div>
    </section>
  );
}

export function OnRecordSite() {
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("motion-ready");
    const elements = document.querySelectorAll<HTMLElement>("[data-reveal]");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -8%", threshold: 0.12 },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="marketing-site">
      <section className="hero" id="top">
        <div className="hero-noise" aria-hidden="true" />
        <nav className="site-nav" aria-label="Primary navigation">
          <a className="wordmark wordmark-light" href="#top" aria-label="OnRecord home">
            <span className="wordmark-glyph" aria-hidden="true"><i /><i /><i /></span>
            <span>OnRecord</span>
          </a>
          <div className="nav-links" data-open={navOpen}>
            <a href="#product" onClick={() => setNavOpen(false)}>Product</a>
            <a href="#method" onClick={() => setNavOpen(false)}>Method</a>
            <a href="#proof" onClick={() => setNavOpen(false)}>Product proof</a>
            <a href="#architecture" onClick={() => setNavOpen(false)}>Architecture</a>
            <a href="#trust" onClick={() => setNavOpen(false)}>Trust</a>
          </div>
          <div className="nav-actions">
            <button
              className="nav-toggle"
              type="button"
              aria-expanded={navOpen}
              aria-label="Toggle navigation"
              onClick={() => setNavOpen((open) => !open)}
            >
              <span /><span />
            </button>
            <a className="button button-ivory nav-demo" href={demoHref}>
              Explore demo <span aria-hidden="true">↗</span>
            </a>
          </div>
        </nav>

        <div className="hero-layout shell">
          <div className="hero-copy">
            <p className="kicker hero-kicker">Evidence-first incident review</p>
            <h1>The incident is over.<br /><em>The truth isn’t ready.</em></h1>
            <p className="hero-intro">
              OnRecord turns fragmented Slack conversations into a source-linked
              postmortem your team can verify, revise, and stand behind.
            </p>
            <div className="hero-actions">
              <a className="button button-signal" href={demoHref}>
                Explore the incident <span aria-hidden="true">→</span>
              </a>
              <a className="text-link" href="#method">See how it works <span aria-hidden="true">↓</span></a>
            </div>
            <div className="hero-proof" aria-label="Product safeguards">
              <span>Source linked</span><span>Human approved</span><span>History preserved</span>
            </div>
          </div>

          <div className="record-composition" aria-label="Evidence converging into an approved incident record">
            <div className="ambient-orbit orbit-one" aria-hidden="true" />
            <div className="ambient-orbit orbit-two" aria-hidden="true" />
            <div className="source-stack" aria-hidden="true">
              <div className="source-chip source-chip-one"><span className="source-avatar">MC</span><p>Failures may be happening before requests reach checkout.</p><time>09:07</time></div>
              <div className="source-chip source-chip-two"><span className="source-avatar source-avatar-gold">AR</span><p>Unapproved WAF change found 24 seconds before impact.</p><time>09:10</time></div>
              <div className="source-chip source-chip-three"><span className="source-avatar">MC</span><p>Deployment timing is suspicious, but not yet causal.</p><time>09:12</time></div>
            </div>
            <div className="record-card">
              <div className="record-card-top">
                <span className="record-seal">OR</span>
                <div><small>INC-DEMO-1042</small><strong>EU checkout outage</strong></div>
                <span className="status-chip"><i /> Needs review</span>
              </div>
              <div className="record-rule" />
              <div className="record-section">
                <small>SUPPORTED FINDING</small>
                <p>An unauthorized WAF rule blocked checkout requests at the edge.</p>
                <div className="citation-row"><span>3 sources</span><span>Directly observed</span></div>
              </div>
              <div className="record-section record-section-muted">
                <small>OPEN QUESTION</small>
                <p>How was the authenticated session acquired?</p>
              </div>
              <div className="record-footer"><span>Evidence coverage · 3 channels</span><span>Revision 01</span></div>
            </div>
          </div>
        </div>
        <div className="hero-caption shell"><span>Slack conversations</span><i /><span>Evidence graph</span><i /><span>Approved record</span></div>
      </section>

      <section className="manifesto section-pad">
        <div className="shell manifesto-grid">
          <div data-reveal>
            <p className="kicker">The dangerous part isn’t the blank page</p>
            <h2>It’s the confident sentence nobody can defend.</h2>
          </div>
          <div className="manifesto-copy" data-reveal>
            <p>
              During an incident, observations sit beside guesses. Decisions are
              buried between status updates. Contradictions arrive out of order.
            </p>
            <p>
              A conventional AI summary smooths that mess into fluent prose.
              OnRecord does the opposite: it preserves the seams, so a reviewer
              can see why every conclusion exists.
            </p>
          </div>
        </div>
        <div className="fragment-marquee" aria-hidden="true">
          <span>observed</span><i>09:07</i><span>asserted</span><i>09:10</i><span>disputed</span><i>09:12</i><span>unknown</span><i>09:15</i><span>confirmed</span>
        </div>
      </section>

      <ProductWorkspace />

      <WorkflowWalkthrough />

      <section className="method section-pad" id="method">
        <div className="shell">
          <div className="section-heading" data-reveal>
            <p className="kicker">From signal to record</p>
            <h2>A disciplined path through messy evidence.</h2>
            <p>No autonomous diagnosis. No one-prompt postmortem. No silent upgrade from “maybe” to “fact”.</p>
          </div>
          <div className="workflow-line" data-reveal>
            {workflow.map((item) => (
              <article className="workflow-step" key={item.step}>
                <div className="workflow-index"><span>{item.step}</span><i /></div>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>

        </div>
      </section>

      <section className="proof-section section-pad" id="proof">
        <div className="shell">
          <div className="section-heading section-heading-wide" data-reveal>
            <p className="kicker">Show the work</p>
            <h2>Four product boundaries.<br />Each one is inspectable.</h2>
            <p>“Implemented” means code and tests exist. It does not mean a customer environment has already been provisioned.</p>
          </div>
          <div className="proof-journey">
            {productProof.map((item) => (
              <article key={item.index} data-reveal>
                <div className="proof-index"><span>{item.index}</span><i /></div>
                <p className="kicker">{item.eyebrow}</p>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
                <span className="proof-status">{item.status}</span>
              </article>
            ))}
          </div>
          <div className="capability-heading" data-reveal>
            <div><p className="kicker">Capability ledger</p><h3>What exists, what runs here, and what comes next.</h3></div>
            <a className="text-link" href={demoHref}>Verify the review experience <span aria-hidden="true">↗</span></a>
          </div>
          <div className="capability-story">
            {capabilityGroups.slice(0, 2).map((group, index) => (
              <article className="capability-card capability-card-featured" data-tone={group.tone} data-side={index % 2 === 0 ? "right" : "left"} key={group.status} data-reveal>
                <div className="capability-copy">
                  <div className="capability-status"><i /><span>{group.status}</span></div>
                  <p>{group.description}</p>
                  <ul>
                    {group.items.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                {group.visual ? (
                  <figure className="capability-visual">
                    <div className="capability-browser-bar" aria-hidden="true"><span /><span /><span /><b>onrecord / review</b></div>
                    {/* Fixed, repository-owned demo captures do not need a runtime image optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={group.visual.src} alt={group.visual.alt} width={1280} height={720} loading="lazy" decoding="async" />
                    <figcaption><i />{group.visual.caption}</figcaption>
                  </figure>
                ) : null}
              </article>
            ))}
            <div className="capability-followups">
              {capabilityGroups.slice(2).map((group) => (
                <article className="capability-card capability-card-compact" data-tone={group.tone} key={group.status} data-reveal>
                  <div className="capability-status"><i /><span>{group.status}</span></div>
                  <p>{group.description}</p>
                  <ul>
                    {group.items.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </article>
              ))}
            </div>
          </div>
          <p className="ledger-note" data-reveal>Capability status reflects the repository as of July 2026. The public demo never connects to customer systems or publishes externally.</p>
        </div>
      </section>

      <ArchitectureJourney />

      <ImplementationStack />

      <section className="principles section-pad" id="trust">
        <div className="shell">
          <div className="section-heading section-heading-wide" data-reveal>
            <p className="kicker">Trust is a product behaviour</p>
            <h2>The model drafts.<br />It does not decide.</h2>
          </div>
          <div className="principle-list">
            {principles.map(([title, copy], index) => (
              <article key={title} data-reveal>
                <span>0{index + 1}</span><h3>{title}</h3><p>{copy}</p>
              </article>
            ))}
          </div>
          <div className="trust-note" data-reveal>
            <div className="trust-symbol" aria-hidden="true"><span /><span /><span /></div>
            <p>Built with tenant-scoped authorization, immutable revisions, bounded model access, retry-safe publication, and source-content-free operational logs.</p>
            <span className="trust-state"><i /> Human approval required</span>
          </div>
        </div>
      </section>

      <section className="closing">
        <div className="closing-glow" aria-hidden="true" />
        <div className="shell closing-content" data-reveal>
          <p className="kicker kicker-light">Synthetic incident. Production interface.</p>
          <h2>See what changes when every conclusion has to show its work.</h2>
          <p>Review the evidence, challenge the draft, and put one revision on the record.</p>
          <a className="button button-signal button-large" href={demoHref}>Enter the demo <span aria-hidden="true">→</span></a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="shell footer-main">
          <a className="wordmark" href="#top"><span className="wordmark-glyph" aria-hidden="true"><i /><i /><i /></span><span>OnRecord</span></a>
          <p>Evidence-first incident review from Slack to an approved record.</p>
          <a href={demoHref}>Explore demo <span aria-hidden="true">↗</span></a>
        </div>
        <div className="shell footer-meta"><span>OnRecord · 2026</span><span>Built for incident truth, not incident theatre.</span></div>
      </footer>
    </main>
  );
}
