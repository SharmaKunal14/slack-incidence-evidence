// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearEvidenceFocus,
  focusEvidenceSource,
} from '../../web/src/evidence-focus.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('evidence focus', () => {
  it('focuses the source and triggering chip while scrolling only the evidence container', () => {
    const outer = document.createElement('main');
    const container = document.createElement('section');
    const source = document.createElement('article');
    const trigger = document.createElement('button');
    container.className = 'evidence-tab-content';
    source.id = 'source-evidence-1';
    outer.append(container);
    container.append(source);
    document.body.append(outer, trigger);

    Object.defineProperties(container, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1_000 },
      scrollTop: { value: 0, writable: true },
    });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
      rectangle(0, 0, 300, 200),
    );
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(
      rectangle(0, 700, 300, 80),
    );
    const containerScroll = vi.fn();
    Object.assign(container, { scrollTo: containerScroll });
    const outerScroll = vi.fn();
    Object.assign(outer, { scrollTo: outerScroll });
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

    const focus = focusEvidenceSource('evidence-1', trigger);

    expect(focus).not.toBeNull();
    expect(source.classList.contains('source-focus-target')).toBe(true);
    expect(source.classList.contains('source-focus-pulse')).toBe(true);
    expect(trigger.classList.contains('source-focus-trigger')).toBe(true);
    expect(trigger.classList.contains('source-focus-pulse')).toBe(true);
    expect(containerScroll).toHaveBeenCalledWith({
      top: 684,
      behavior: 'smooth',
    });
    expect(outerScroll).not.toHaveBeenCalled();
  });

  it('clears both focus treatments together', () => {
    const source = document.createElement('article');
    const trigger = document.createElement('button');
    source.classList.add('source-focus-target', 'source-focus-pulse');
    trigger.classList.add('source-focus-trigger', 'source-focus-pulse');

    clearEvidenceFocus({ source, trigger });

    expect(source.classList).not.toContain('source-focus-target');
    expect(trigger.classList).not.toContain('source-focus-trigger');
  });
});

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  };
}
