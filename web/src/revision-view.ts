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

export interface RevisionSourceQuestion {
  readonly id: string;
  readonly question: string;
}

export interface SavedRevisionQuestionAnswer {
  readonly questionId: string;
  readonly question: string;
  readonly answer: string;
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

export function reconcileRevisionQuestionAnswers(
  questions: readonly RevisionSourceQuestion[],
  savedAnswers: readonly SavedRevisionQuestionAnswer[] | null,
): ReadonlyMap<string, string> {
  const questionById = new Map<string, RevisionSourceQuestion>();
  for (const question of questions) {
    if (questionById.has(question.id)) {
      throw new Error('Incident contains duplicate open-question identifiers');
    }
    questionById.set(question.id, question);
  }

  const answers = new Map(questions.map((question) => [question.id, '']));
  if (savedAnswers === null) {
    return answers;
  }
  const savedQuestionIds = new Set<string>();
  for (const saved of savedAnswers) {
    const source = questionById.get(saved.questionId);
    if (source === undefined) {
      throw new Error('Saved revision references an unknown open question');
    }
    if (savedQuestionIds.has(saved.questionId)) {
      throw new Error('Saved revision contains duplicate question answers');
    }
    if (saved.question !== source.question) {
      throw new Error('Saved question answer does not match its source');
    }
    savedQuestionIds.add(saved.questionId);
    answers.set(saved.questionId, saved.answer);
  }
  return answers;
}
