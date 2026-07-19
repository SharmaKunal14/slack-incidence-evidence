export interface RevisionSourceStatement {
  readonly id: string;
  readonly sectionType: string;
  readonly position: number;
  readonly text: string;
  readonly classification: string;
}

export interface SavedRevisionStatement {
  readonly originalStatementId: string;
  readonly sectionType: string;
  readonly position: number;
  readonly decision: 'KEEP' | 'EDIT' | 'EXCLUDE';
  readonly text: string | null;
  readonly classification: string | null;
}

export interface RevisionStatementView {
  readonly decision: 'KEEP' | 'EDIT' | 'EXCLUDE';
  readonly text: string;
  readonly classification: string;
}

export function requiresPreservedRevisionFetch(
  selectedVersionId: string,
  originalDraftId: string,
  latestRevisionId: string,
): boolean {
  return (
    selectedVersionId !== originalDraftId &&
    selectedVersionId !== latestRevisionId
  );
}

export function reconcileRevisionStatements(
  sources: readonly RevisionSourceStatement[],
  revisionStatements: readonly SavedRevisionStatement[] | null,
): ReadonlyMap<string, RevisionStatementView> {
  const sourceById = new Map<string, RevisionSourceStatement>();
  for (const source of sources) {
    if (sourceById.has(source.id)) {
      throw new Error('Report draft contains duplicate statement identifiers');
    }
    sourceById.set(source.id, source);
  }

  if (revisionStatements === null) {
    return new Map(
      sources.map((source) => [
        source.id,
        {
          decision: 'KEEP',
          text: source.text,
          classification: source.classification,
        },
      ]),
    );
  }
  if (revisionStatements.length !== sources.length) {
    throw new Error('Saved revision is incomplete');
  }

  const views = new Map<string, RevisionStatementView>();
  for (const saved of revisionStatements) {
    const source = sourceById.get(saved.originalStatementId);
    if (source === undefined) {
      throw new Error('Saved revision references an unknown statement');
    }
    if (views.has(source.id)) {
      throw new Error('Saved revision contains duplicate statement decisions');
    }
    if (
      saved.sectionType !== source.sectionType ||
      saved.position !== source.position
    ) {
      throw new Error('Saved revision statement does not match its source');
    }
    if (saved.decision === 'EXCLUDE') {
      if (saved.text !== null || saved.classification !== null) {
        throw new Error('Excluded revision statement contains report content');
      }
      views.set(source.id, {
        decision: saved.decision,
        text: source.text,
        classification: source.classification,
      });
      continue;
    }
    if (saved.text === null || saved.classification === null) {
      throw new Error('Included revision statement is missing report content');
    }
    views.set(source.id, {
      decision: saved.decision,
      text: saved.text,
      classification: saved.classification,
    });
  }
  return views;
}
