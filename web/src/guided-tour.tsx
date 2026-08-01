import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

const tourCompletionKey = 'onrecord_demo_tour_completed_v1';

interface TourStep {
  readonly copy: string;
  readonly eyebrow: string;
  readonly graphic: 'converge' | 'evidence' | 'review' | 'approve';
  readonly placement: 'bottom-left' | 'bottom-right' | 'top-right';
  readonly target: string;
  readonly title: string;
}

interface HighlightBox {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

const tourSteps: readonly TourStep[] = [
  {
    eyebrow: 'The incident record',
    title: 'Start with the record, not a blank page.',
    copy: 'OnRecord assembles a draft from the approved incident scope. Your job is to test it—not trust it.',
    target: 'incident-summary',
    placement: 'bottom-right',
    graphic: 'converge',
  },
  {
    eyebrow: 'Review the draft',
    title: 'Challenge every sentence.',
    copy: 'Keep what holds up, edit what needs context, and exclude what the evidence cannot support.',
    target: 'report',
    placement: 'bottom-right',
    graphic: 'review',
  },
  {
    eyebrow: 'Inspect the evidence',
    title: 'Follow every claim back.',
    copy: 'Open questions, contradictions, timeline events, and Slack sources stay visible beside the draft.',
    target: 'evidence',
    placement: 'bottom-left',
    graphic: 'evidence',
  },
  {
    eyebrow: 'Human authority',
    title: 'Only a human closes the loop.',
    copy: 'A reviewer acknowledges unresolved risk, saves a revision, and explicitly approves the final record.',
    target: 'approval',
    placement: 'top-right',
    graphic: 'approve',
  },
];

export function hasCompletedDemoTour(): boolean {
  try {
    return window.localStorage.getItem(tourCompletionKey) === 'true';
  } catch {
    return false;
  }
}

export function markDemoTourCompleted(): void {
  try {
    window.localStorage.setItem(tourCompletionKey, 'true');
  } catch {
    // A blocked storage preference should never prevent the tour from closing.
  }
}

export function GuidedTour({
  onClose,
  open,
}: {
  readonly onClose: () => void;
  readonly open: boolean;
}): ReactNode {
  const [stepIndex, setStepIndex] = useState(0);
  const [highlight, setHighlight] = useState<HighlightBox | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const step = tourSteps[stepIndex] ?? tourSteps[0];

  useEffect(() => {
    if (!open) {
      setStepIndex(0);
      setHighlight(null);
      return;
    }

    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>('[data-tour-primary]')
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      previousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || step === undefined) return;
    const target = document.querySelector<HTMLElement>(
      `[data-tour-target="${step.target}"]`,
    );
    if (target === null) {
      setHighlight(null);
      return;
    }

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    target.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });

    const updateHighlight = (): void => {
      const rect = target.getBoundingClientRect();
      const padding = 10;
      const viewportPadding = 12;
      const left = Math.max(viewportPadding, rect.left - padding);
      const top = Math.max(viewportPadding, rect.top - padding);
      setHighlight({
        left,
        top,
        width: Math.max(
          0,
          Math.min(
            window.innerWidth - left - viewportPadding,
            rect.width + padding * 2,
          ),
        ),
        height: Math.max(
          0,
          Math.min(
            window.innerHeight - top - viewportPadding,
            rect.height + padding * 2,
          ),
        ),
      });
    };

    updateHighlight();
    const settleTimer = window.setTimeout(
      updateHighlight,
      reducedMotion ? 0 : 480,
    );
    window.addEventListener('resize', updateHighlight);
    window.addEventListener('scroll', updateHighlight, { passive: true });
    return () => {
      window.clearTimeout(settleTimer);
      window.removeEventListener('resize', updateHighlight);
      window.removeEventListener('scroll', updateHighlight);
    };
  }, [open, step]);

  if (!open || step === undefined) return null;

  const closeTour = (): void => {
    markDemoTourCompleted();
    onClose();
  };
  const highlightStyle =
    highlight === null
      ? undefined
      : ({
          '--tour-height': `${highlight.height}px`,
          '--tour-left': `${highlight.left}px`,
          '--tour-top': `${highlight.top}px`,
          '--tour-width': `${highlight.width}px`,
        } as CSSProperties);

  return (
    <div className="guided-tour-layer">
      <div className="guided-tour-input-blocker" aria-hidden="true" />
      <div
        className="guided-tour-highlight"
        data-visible={highlight !== null}
        style={highlightStyle}
        aria-hidden="true"
      />
      <div
        aria-describedby="guided-tour-copy"
        aria-labelledby="guided-tour-title"
        aria-modal="true"
        className="guided-tour-card"
        data-placement={step.placement}
        onKeyDown={(event) => trapDialogFocus(event, dialogRef.current)}
        ref={dialogRef}
        role="dialog"
      >
        <div className="guided-tour-topline">
          <span>
            Guided tour · {stepIndex + 1} of {tourSteps.length}
          </span>
          <button
            aria-label="Close guided tour"
            className="guided-tour-close"
            onClick={closeTour}
            type="button"
          >
            <X size={17} />
          </button>
        </div>
        <TourGraphic variant={step.graphic} />
        <p className="eyebrow">{step.eyebrow}</p>
        <h2 id="guided-tour-title">{step.title}</h2>
        <p id="guided-tour-copy">{step.copy}</p>
        <div className="guided-tour-progress" aria-hidden="true">
          {tourSteps.map((item, index) => (
            <i data-active={index === stepIndex} key={item.target} />
          ))}
        </div>
        <div className="guided-tour-actions">
          <button
            className="guided-tour-skip"
            onClick={closeTour}
            type="button"
          >
            Skip tour
          </button>
          <div>
            {stepIndex > 0 && (
              <button
                aria-label="Previous tour step"
                className="guided-tour-back"
                onClick={() => setStepIndex((current) => current - 1)}
                type="button"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <button
              className="button button-primary"
              data-tour-primary
              onClick={() => {
                if (stepIndex === tourSteps.length - 1) {
                  closeTour();
                } else {
                  setStepIndex((current) => current + 1);
                }
              }}
              type="button"
            >
              {stepIndex === tourSteps.length - 1
                ? 'Explore the incident'
                : 'Next'}
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TourGraphic({
  variant,
}: {
  readonly variant: TourStep['graphic'];
}): ReactNode {
  return (
    <div
      className="guided-tour-graphic"
      data-variant={variant}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
      <i />
    </div>
  );
}

function trapDialogFocus(
  event: KeyboardEvent<HTMLDivElement>,
  dialog: HTMLDivElement | null,
): void {
  if (event.key === 'Escape') {
    event.currentTarget
      .querySelector<HTMLButtonElement>('.guided-tour-close')
      ?.click();
    return;
  }
  if (event.key !== 'Tab' || dialog === null) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('button:not(:disabled)'),
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
