export interface KnownIncidentPerson {
  readonly externalId: string;
  readonly replacement: string;
  readonly aliases: readonly string[];
}

export interface DeidentifyIncidentTextInput {
  readonly texts: readonly string[];
  readonly knownPeople?: readonly KnownIncidentPerson[];
}

export interface InspectIncidentTextInput {
  readonly texts: readonly string[];
  readonly knownPeople?: readonly KnownIncidentPerson[];
}

/** De-identifies text before an external AI call and gates generated output. */
export interface IncidentDeidentifier {
  deidentify(input: DeidentifyIncidentTextInput): Promise<readonly string[]>;
  assertSafe(input: InspectIncidentTextInput): Promise<void>;
}

export class IncidentDeidentificationError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super('Incident text could not pass the privacy boundary', options);
    this.name = 'IncidentDeidentificationError';
  }
}
