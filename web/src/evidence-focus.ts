export interface EvidenceFocus {
  readonly source: HTMLElement;
  readonly trigger: HTMLButtonElement;
}

const sourceFocusClass = 'source-focus-target';
const triggerFocusClass = 'source-focus-trigger';
const arrivalClass = 'source-focus-pulse';

export function clearEvidenceFocus(focus: EvidenceFocus | null): void {
  if (focus === null) return;
  focus.source.classList.remove(sourceFocusClass, arrivalClass);
  focus.trigger.classList.remove(triggerFocusClass, arrivalClass);
}

export function focusEvidenceSource(
  id: string,
  trigger: HTMLButtonElement,
): EvidenceFocus | null {
  const source = document.getElementById(`source-${id}`);
  if (source === null) return null;

  source.classList.add(sourceFocusClass, arrivalClass);
  trigger.classList.add(triggerFocusClass, arrivalClass);
  scrollWithinEvidenceContainer(source);
  return { source, trigger };
}

function scrollWithinEvidenceContainer(source: HTMLElement): void {
  const container = source.closest<HTMLElement>('.evidence-tab-content');
  if (container === null) return;

  const sourceBounds = source.getBoundingClientRect();
  const containerBounds = container.getBoundingClientRect();
  const targetTop =
    container.scrollTop +
    sourceBounds.top -
    containerBounds.top -
    (container.clientHeight - sourceBounds.height) / 2;
  const maximumTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight,
  );
  const top = Math.min(Math.max(0, targetTop), maximumTop);

  container.scrollTo({
    top,
    behavior: reducedMotion() ? 'auto' : 'smooth',
  });
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
