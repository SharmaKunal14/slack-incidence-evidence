"use client";

import { Fragment, useEffect, useState, type CSSProperties } from "react";

const demoHref = "/review-demo/demo.html";
const connectSlackHref = requireHttpsUrl(
  process.env.NEXT_PUBLIC_APP_URL ??
    "https://dk95lfvlz4v6e.cloudfront.net/#/settings/integrations",
);

function requireHttpsUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("NEXT_PUBLIC_APP_URL must be a trusted HTTPS URL");
  }
  return parsed.toString();
}

const workflow = [
  {
    step: "01",
    kicker: "Approved scope",
    title: "Start with the evidence.",
    copy: "Choose the channels, threads, and time window. OnRecord collects only what you approve.",
  },
  {
    step: "02",
    kicker: "Evidence graph",
    title: "Separate fact from assumption.",
    copy: "Every claim stays linked to its source. Contradictions and unanswered questions remain visible.",
  },
  {
    step: "03",
    kicker: "Human authority",
    title: "Let a human make the record.",
    copy: "Edit, approve, and publish one revision. The model never gets the final word.",
  },
] as const;

const principles = [
  ["Sources stay attached.", "Every conclusion keeps a visible path back to the evidence."],
  ["Uncertainty stays visible.", "Disputes, gaps, and unanswered questions cannot be polished away."],
  ["Nothing publishes without approval.", "Only a human can approve the record or create an external effect."],
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
          <p className="kicker kicker-light">The review workspace</p>
          <h2>Every sentence has somewhere to point.</h2>
          <p>
            Review the draft beside its evidence. Keep what holds up. Change
            what doesn&apos;t. Publish only when the record is ready.
          </p>
          <a className="button button-ivory" href={demoHref}>Open the review workspace <span aria-hidden="true">→</span></a>
          <small className="product-disclosure">Production interface with synthetic evidence. External effects are disabled.</small>
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

function StoryReveal({ activeStep }: { activeStep: number }) {
  return (
    <section className="story-section" id="method">
      <div className="shell story-layout">
        <div className="story-stage" data-active-step={activeStep} aria-label="An incident moving from Slack evidence to a human-approved record">
          <div className="story-stage-topline"><span>Incident · INC-DEMO-1042</span><span>0{activeStep + 1} / 03</span></div>
          <div className="story-panel story-panel-sources" data-story-panel="0">
            <p className="story-panel-label">Approved Slack scope</p>
            <div className="story-source-card"><span>09:07 · #incident-checkout</span><p>Failures may be happening before requests reach checkout.</p></div>
            <div className="story-source-card"><span>09:10 · #security-alerts</span><p>Unapproved WAF change found 24 seconds before impact.</p></div>
            <div className="story-source-card"><span>09:12 · #deployments</span><p>Deployment timing is suspicious, but not yet causal.</p></div>
          </div>
          <div className="story-panel story-panel-graph" data-story-panel="1">
            <p className="story-panel-label">Evidence graph</p>
            <div className="story-graph-row"><span>Observed</span><strong>WAF rule changed at 08:57:42</strong><i>2 sources</i></div>
            <div className="story-graph-row"><span>Disputed</span><strong>Deployment caused the outage</strong><i>3 sources</i></div>
            <div className="story-graph-row"><span>Unknown</span><strong>How was the session acquired?</strong><i>Open question</i></div>
          </div>
          <div className="story-panel story-panel-approved" data-story-panel="2">
            <p className="story-panel-label">Human-approved revision</p>
            <span className="story-approved-state"><i /> Approved</span>
            <h3>EU checkout outage</h3>
            <p>An unauthorized WAF rule blocked checkout requests at the edge.</p>
            <div><span>7 evidence sources</span><span>Revision 01</span></div>
          </div>
        </div>
        <div className="story-chapters">
          <header data-reveal>
            <p className="kicker">From noise to record</p>
            <h2>One incident.<br />Three acts.</h2>
          </header>
          {workflow.map((item, index) => (
            <article className="story-chapter" data-story-step={index} key={item.step}>
              <span>{item.step}</span>
              <p className="kicker">{item.kicker}</p>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function WalkthroughDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="walkthrough-dialog" role="dialog" aria-modal="true" aria-labelledby="walkthrough-title">
      <button className="walkthrough-backdrop" type="button" onClick={onClose} aria-label="Close walkthrough" />
      <div className="walkthrough-dialog-panel">
        <div className="walkthrough-dialog-heading">
          <div>
            <p className="kicker">2-minute product story</p>
            <h2 id="walkthrough-title">Slack evidence to approved record.</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close walkthrough" autoFocus>×</button>
        </div>
        <video controls autoPlay playsInline preload="metadata" poster="/video/onrecord-workflow-poster.jpg">
          <source src="/video/onrecord-workflow-120s.mp4" type="video/mp4" />
          <track kind="captions" src="/video/onrecord-workflow-120s.vtt" srcLang="en" label="English workflow captions" />
          Your browser does not support embedded video.
        </video>
        <p>Connected test environment · synthetic incident data · sequences accelerated</p>
      </div>
    </div>
  );
}

function TechnicalProof() {
  return (
    <section className="technical-proof" id="technical">
      <details className="shell technical-disclosure">
        <summary>
          <span><small>Technical appendix</small><strong>Want to see how it is built?</strong></span>
          <i aria-hidden="true">+</i>
        </summary>
        <div className="technical-content">
          <ArchitectureJourney />
          <ImplementationStack />
        </div>
      </details>
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
  const [activeStory, setActiveStory] = useState(0);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);

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

  useEffect(() => {
    const steps = document.querySelectorAll<HTMLElement>("[data-story-step]");
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        if (visible?.target instanceof HTMLElement) {
          setActiveStory(Number(visible.target.dataset.storyStep));
        }
      },
      { rootMargin: "-30% 0px -30%", threshold: [0.2, 0.5, 0.8] },
    );
    for (const step of steps) observer.observe(step);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!walkthroughOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWalkthroughOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [walkthroughOpen]);

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
            <a href="#method" onClick={() => setNavOpen(false)}>How it works</a>
            <a href="#trust" onClick={() => setNavOpen(false)}>Trust</a>
            <a href="#technical" onClick={() => setNavOpen(false)}>Technical proof</a>
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
            <a className="button button-ivory nav-demo" href={connectSlackHref}>
              Connect Slack <span aria-hidden="true">→</span>
            </a>
          </div>
        </nav>

        <div className="hero-layout shell">
          <div className="hero-copy">
            <p className="kicker hero-kicker">Evidence-first incident review</p>
            <h1>The incident is over.<br /><em>The truth isn’t ready.</em></h1>
            <p className="hero-intro">
              OnRecord turns messy Slack conversations into an evidence-linked
              incident record—reviewed and approved by a human.
            </p>
            <div className="hero-actions">
              <a className="button button-signal" href={connectSlackHref}>
                Connect your Slack <span aria-hidden="true">→</span>
              </a>
              <div className="hero-action-links">
                <a className="text-link" href={demoHref}>
                  Explore the demo <span aria-hidden="true">↗</span>
                </a>
                <button className="text-link" type="button" onClick={() => setWalkthroughOpen(true)}>
                  Watch the 2-minute story <span aria-hidden="true">↗</span>
                </button>
              </div>
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
            <p className="kicker">The risk</p>
            <h2>Fluent is not the same as true.</h2>
          </div>
          <div className="manifesto-copy" data-reveal>
            <p>
              AI can write a convincing postmortem. OnRecord makes every
              conclusion show its evidence.
            </p>
          </div>
        </div>
        <div className="fragment-marquee" aria-hidden="true">
          <span>observed</span><i>09:07</i><span>asserted</span><i>09:10</i><span>disputed</span><i>09:12</i><span>unknown</span><i>09:15</i><span>confirmed</span>
        </div>
      </section>

      <StoryReveal activeStep={activeStory} />

      <ProductWorkspace />

      <section className="principles section-pad" id="trust">
        <div className="shell">
          <div className="section-heading section-heading-wide" data-reveal>
            <p className="kicker">Human authority</p>
            <h2>The model drafts.<br />Your team decides.</h2>
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
            <p>Real interface. Tested workflow. Controlled external effects.</p>
            <span className="trust-state"><i /> Human approval required</span>
          </div>
        </div>
      </section>

      <section className="proof-strip" aria-label="Product proof">
        <div className="shell proof-strip-grid">
          <div><span>01</span><strong>Production review components</strong></div>
          <div><span>02</span><strong>Evidence-linked revision history</strong></div>
          <div><span>03</span><strong>Confluence and Notion publication paths</strong></div>
        </div>
      </section>

      <section className="closing">
        <div className="closing-glow" aria-hidden="true" />
        <div className="shell closing-content" data-reveal>
          <p className="kicker kicker-light">Evidence first. Human approved.</p>
          <h2>Put the incident on the record.</h2>
          <p>Review the evidence. Challenge the draft. Approve what your team can defend.</p>
          <a className="button button-signal button-large" href={connectSlackHref}>Connect your Slack <span aria-hidden="true">→</span></a>
        </div>
      </section>

      <TechnicalProof />

      <footer className="site-footer">
        <div className="shell footer-main">
          <a className="wordmark" href="#top"><span className="wordmark-glyph" aria-hidden="true"><i /><i /><i /></span><span>OnRecord</span></a>
          <p>Evidence-first incident review from Slack to an approved record.</p>
          <a href={demoHref}>Explore demo <span aria-hidden="true">↗</span></a>
        </div>
        <div className="shell footer-meta"><span>OnRecord · 2026</span><span>Built for incident truth, not incident theatre.</span></div>
      </footer>
      {walkthroughOpen ? <WalkthroughDialog onClose={() => setWalkthroughOpen(false)} /> : null}
    </main>
  );
}
