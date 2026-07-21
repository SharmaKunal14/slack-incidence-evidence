// @vitest-environment jsdom
/// <reference lib="dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatementEditor, type StatementState } from '../../web/src/app.js';
import type { Statement } from '../../web/src/contracts.js';

const statement: Statement = {
  id: 'statement-1',
  sectionType: 'root_cause',
  position: 0,
  statementType: 'claim',
  text: 'The deployment may have exhausted the connection pool.',
  classification: 'hypothesis',
  claimIds: ['claim-1'],
  timelineEventIds: [],
};

afterEach(cleanup);

function Harness({
  onOpenSource,
}: {
  readonly onOpenSource: (id: string, trigger: HTMLButtonElement) => void;
}): ReactNode {
  const [state, setState] = useState<StatementState>({
    decision: 'KEEP',
    text: statement.text,
    classification: statement.classification,
  });
  return createElement(StatementEditor, {
    editable: true,
    onChange: setState,
    onOpenSource,
    state,
    statement,
  });
}

describe('StatementEditor', () => {
  it('moves naturally between keep, edit, and exclude decisions', () => {
    render(createElement(Harness, { onOpenSource: vi.fn() }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Reviewed statement',
    });
    fireEvent.change(editor, {
      target: { value: 'A human-confirmed connection pool exhaustion.' },
    });
    expect(editor.value).toBe('A human-confirmed connection pool exhaustion.');

    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }));
    expect(screen.getByText('Excluded from the reviewed report')).toBeDefined();
    expect(screen.getByText(statement.text)).toBeDefined();
  });

  it('opens the source represented by an evidence chip', () => {
    const onOpenSource = vi.fn();
    render(createElement(Harness, { onOpenSource }));

    fireEvent.click(screen.getByRole('button', { name: /Source claim-1/u }));

    expect(onOpenSource).toHaveBeenCalledExactlyOnceWith(
      'claim-1',
      expect.any(HTMLButtonElement),
    );
  });
});
