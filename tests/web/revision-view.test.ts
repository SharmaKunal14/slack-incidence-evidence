import { describe, expect, it } from 'vitest';
import {
  reconcileRevisionStatements,
  requiresPreservedRevisionFetch,
} from '../../web/src/revision-view.js';

const sources = [
  {
    id: 'statement-1',
    sectionType: 'root_cause',
    position: 0,
    text: 'The deploy may have caused the outage.',
    classification: 'hypothesis',
  },
  {
    id: 'statement-2',
    sectionType: 'impact',
    position: 0,
    text: 'Checkout requests failed.',
    classification: 'directly_observed',
  },
] as const;

describe('revision statement reconciliation', () => {
  it('shows the original draft as keep decisions before any revision exists', () => {
    const views = reconcileRevisionStatements(sources, null);

    expect(views.get('statement-1')).toEqual({
      decision: 'KEEP',
      text: sources[0].text,
      classification: sources[0].classification,
    });
  });

  it('shows saved edits and exclusions from the latest immutable revision', () => {
    const views = reconcileRevisionStatements(sources, [
      {
        originalStatementId: 'statement-1',
        sectionType: 'root_cause',
        position: 0,
        decision: 'EDIT',
        text: 'The deployment exhausted the database connection pool.',
        classification: 'human_confirmed',
      },
      {
        originalStatementId: 'statement-2',
        sectionType: 'impact',
        position: 0,
        decision: 'EXCLUDE',
        text: null,
        classification: null,
      },
    ]);

    expect(views.get('statement-1')).toEqual({
      decision: 'EDIT',
      text: 'The deployment exhausted the database connection pool.',
      classification: 'human_confirmed',
    });
    expect(views.get('statement-2')).toEqual({
      decision: 'EXCLUDE',
      text: sources[1].text,
      classification: sources[1].classification,
    });
  });

  it('fails closed when a saved revision is incomplete', () => {
    expect(() =>
      reconcileRevisionStatements(sources, [
        {
          originalStatementId: 'statement-1',
          sectionType: 'root_cause',
          position: 0,
          decision: 'KEEP',
          text: sources[0].text,
          classification: sources[0].classification,
        },
      ]),
    ).toThrow('Saved revision is incomplete');
  });

  it('fails closed when a saved decision points at the wrong source', () => {
    expect(() =>
      reconcileRevisionStatements(sources, [
        {
          originalStatementId: 'statement-1',
          sectionType: 'impact',
          position: 0,
          decision: 'KEEP',
          text: sources[0].text,
          classification: sources[0].classification,
        },
        {
          originalStatementId: 'statement-2',
          sectionType: 'impact',
          position: 0,
          decision: 'KEEP',
          text: sources[1].text,
          classification: sources[1].classification,
        },
      ]),
    ).toThrow('Saved revision statement does not match its source');
  });
});

describe('preserved revision loading', () => {
  const originalDraftId = 'original-draft';
  const latestRevisionId = 'latest-revision';

  it('does not fetch the original or already-loaded latest revision', () => {
    expect(
      requiresPreservedRevisionFetch(
        originalDraftId,
        originalDraftId,
        latestRevisionId,
      ),
    ).toBe(false);
    expect(
      requiresPreservedRevisionFetch(
        latestRevisionId,
        originalDraftId,
        latestRevisionId,
      ),
    ).toBe(false);
  });

  it('fetches only a selected historical revision', () => {
    expect(
      requiresPreservedRevisionFetch(
        'historical-revision',
        originalDraftId,
        latestRevisionId,
      ),
    ).toBe(true);
  });
});
