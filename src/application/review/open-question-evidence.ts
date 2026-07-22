const LEGACY_EVIDENCE_SUFFIX =
  /\s*\[((?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})*)\]\s*$/iu;

/** Reads legacy model-appended UUID citations without exposing them as prose. */
export function splitLegacyQuestionEvidence(value: string): {
  readonly question: string;
  readonly evidenceIds: readonly string[];
} {
  const suffix = LEGACY_EVIDENCE_SUFFIX.exec(value);
  if (suffix?.[1] === undefined) {
    return { question: value, evidenceIds: [] };
  }
  return {
    question: value.slice(0, suffix.index).trim(),
    evidenceIds: suffix[1].split(',').map((id) => id.trim()),
  };
}
