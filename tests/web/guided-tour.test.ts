// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuidedTour, hasCompletedDemoTour } from '../../web/src/guided-tour.js';

describe('sample incident guided tour', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => cleanup());

  it('walks through the real review landmarks and remembers completion', () => {
    const onClose = vi.fn();
    renderTour(onClose);

    expect(
      screen.getByRole('heading', {
        name: 'Start with the record, not a blank page.',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByRole('heading', { name: 'Challenge every sentence.' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByRole('heading', { name: 'Follow every claim back.' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByRole('heading', {
        name: 'Only a human closes the loop.',
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Explore the incident' }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(hasCompletedDemoTour()).toBe(true);
  });

  it('closes safely with Escape and records the preference', () => {
    const onClose = vi.fn();
    renderTour(onClose);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    expect(hasCompletedDemoTour()).toBe(true);
  });
});

function renderTour(onClose: () => void): void {
  render(
    createElement(
      Fragment,
      null,
      ['incident-summary', 'report', 'evidence', 'approval'].map((target) =>
        createElement('div', { 'data-tour-target': target, key: target }),
      ),
      createElement(GuidedTour, { onClose, open: true }),
    ),
  );
}
