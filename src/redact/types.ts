// Shared types for the on-device redaction pipeline.

export const ENTITY_TYPES = ['PERSON', 'EMAIL', 'PHONE', 'ADDRESS', 'DATE', 'ID', 'URL', 'ORG'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_LABELS: Record<EntityType, string> = {
  PERSON: 'Names',
  EMAIL: 'Emails',
  PHONE: 'Phone numbers',
  ADDRESS: 'Addresses & places',
  DATE: 'Personal dates',
  ID: 'ID & account numbers',
  URL: 'Links & IPs',
  ORG: 'Organizations',
};

/** Where a detection came from. "rule" = deterministic regex, "nano" = Gemini Nano on device, "verify" = second on-device pass, "user" = added in review. */
export type DetectionSource = 'rule' | 'nano' | 'verify' | 'propagated' | 'user';

export interface Span {
  start: number;
  end: number; // exclusive
  text: string;
  type: EntityType;
  source: DetectionSource;
}

export interface Candidate {
  text: string;
  type: EntityType;
  source: DetectionSource;
}

export interface Redaction {
  /** Text with every detected value replaced by a placeholder such as [PERSON_1]. */
  redacted: string;
  /** Placeholder -> original value. Never leaves the device. */
  vault: Record<string, string>;
  /** Spans in the original text, with the placeholder each one became. */
  spans: Array<Span & { placeholder: string }>;
  counts: Partial<Record<EntityType, number>>;
}
