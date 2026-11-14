// The on-device half of the airlock: Gemini Nano (through Firebase AI Logic, ONLY_ON_DEVICE) finds
// names, places and other identifiers that rules cannot, then takes a second look at the redacted text.

import { deviceExtractor } from '../firebase';
import { detectRules } from './detectors';
import { applyRedaction, harmonize, locate, propagate } from './merge';
import { ENTITY_TYPES, type Candidate, type EntityType, type Redaction, type Span } from './types';

export type DeviceState = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface LanguageModelStatic {
  availability(opts?: unknown): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
}
declare const LanguageModel: LanguageModelStatic | undefined;

export async function deviceAvailability(): Promise<DeviceState> {
  if (typeof LanguageModel === 'undefined') return 'unavailable';
  try {
    return await LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }] });
  } catch {
    return 'unavailable';
  }
}

/** Must run inside a user gesture (Chrome requires user activation to create the on-device model). */
export async function prepareDevice(onProgress: (p: number) => void) {
  await deviceExtractor.initializeDeviceModel(onProgress);
}

const SCAN_PROMPT = `Find every name in the TEXT that could identify someone. Bracketed tokens such as [PHONE_1] are already hidden: ignore them.
Return three lists:
- people: names of people, including first names on their own, surnames and nicknames (without titles like Dr. or Mr.)
- orgs: employers, companies, clinics, hospitals, schools, agencies
- places: cities, towns, neighborhoods, streets, buildings
Copy each item exactly as written in the TEXT. No duplicates. Leave out medicines, conditions, products and generic words.

TEXT:
`;

const SECOND_LOOK_PROMPT = `This TEXT was already de-identified: bracketed tokens like [PERSON_1] are hidden values and are safe. Find any REMAINING name of a person, organization or place that was missed. Copy each exactly as written. Never list bracketed tokens. If nothing identifying remains, return empty lists.

TEXT:
`;

/** Parse the on-device model's JSON. Anything malformed is ignored rather than trusted. */
export function parseEntities(raw: string, source: Candidate['source']): Candidate[] {
  try {
    const j = JSON.parse(raw) as Partial<Record<'people' | 'orgs' | 'places', unknown>>;
    const pick = (v: unknown, type: EntityType): Candidate[] =>
      (Array.isArray(v) ? v : [])
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 1 && !/^\[.*\]$/.test(x.trim()))
        .map((x) => ({ text: x.trim().replace(/^(?:Dr|Mr|Mrs|Ms|Mx|Prof)\.?\s+/, ''), type, source }));
    return [...pick(j.people, 'PERSON'), ...pick(j.orgs, 'ORG'), ...pick(j.places, 'ADDRESS')];
  } catch {
    return [];
  }
}

/** Split long inputs on paragraph or sentence boundaries so each on-device call stays well inside the context window. */
export function chunk(text: string, size = 3500): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end));
      if (cut > start + size / 2) end = cut + 1;
    }
    out.push({ offset: start, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

async function scan(prompt: string, text: string, source: Candidate['source']): Promise<Candidate[]> {
  const res = await deviceExtractor.generateContent(prompt + text);
  return parseEntities(res.response.text(), source);
}

export interface SealStep {
  id: 'rules' | 'nano' | 'verify';
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  ms?: number;
  found?: number;
  note?: string;
}

export interface SealResult {
  redaction: Redaction;
  spans: Span[];
  steps: SealStep[];
  deviceUsed: boolean;
}

/**
 * Seal = rules + Gemini Nano scan + name propagation + a second on-device look at the redacted text.
 * Nothing in this function makes a network request with the user's text.
 */
export async function seal(
  text: string,
  enabled: Set<EntityType>,
  opts: { device: boolean; verifyPass: boolean; extraSpans?: Span[] },
  onStep: (steps: SealStep[]) => void,
): Promise<SealResult> {
  const steps: SealStep[] = [
    { id: 'rules', label: 'Pattern rules', status: 'pending' },
    { id: 'nano', label: 'Gemini Nano scan', status: opts.device ? 'pending' : 'skipped', note: opts.device ? undefined : 'on-device model unavailable' },
    { id: 'verify', label: 'Second look', status: opts.device && opts.verifyPass ? 'pending' : 'skipped' },
  ];
  const update = (id: SealStep['id'], patch: Partial<SealStep>) => {
    Object.assign(steps.find((s) => s.id === id)!, patch);
    onStep(steps.map((s) => ({ ...s })));
  };

  let t = performance.now();
  update('rules', { status: 'running' });
  const rules = detectRules(text);
  update('rules', { status: 'done', ms: performance.now() - t, found: rules.length });

  let nano: Span[] = [];
  if (opts.device) {
    t = performance.now();
    update('nano', { status: 'running' });
    try {
      const masked = applyRedaction(text, rules, new Set(ENTITY_TYPES)).redacted;
      for (const c of chunk(masked)) {
        const cands = await scan(SCAN_PROMPT, c.text, 'nano');
        nano.push(...cands.flatMap((cand) => locate(text, cand)));
      }
      update('nano', { status: 'done', ms: performance.now() - t, found: nano.length });
    } catch (e) {
      nano = [];
      update('nano', { status: 'error', ms: performance.now() - t, note: (e as Error).message.slice(0, 120) });
    }
  }

  let spans = harmonize([...rules, ...nano, ...(opts.extraSpans ?? [])]);
  spans = [...spans, ...propagate(text, spans)];
  let redaction = applyRedaction(text, spans, enabled);

  if (opts.device && opts.verifyPass && steps.find((s) => s.id === 'nano')!.status === 'done') {
    t = performance.now();
    update('verify', { status: 'running' });
    try {
      let extra: Span[] = [];
      for (const c of chunk(redaction.redacted)) {
        const cands = await scan(SECOND_LOOK_PROMPT, c.text, 'verify');
        // Map findings back to the ORIGINAL text, so they become normal spans.
        extra.push(...cands.flatMap((cand) => locate(text, cand)));
      }
      const known = new Set(spans.map((s) => `${s.start}:${s.end}`));
      extra = extra.filter((s) => !known.has(`${s.start}:${s.end}`));
      if (extra.length) {
        spans = harmonize([...spans, ...extra]);
        spans = [...spans, ...propagate(text, spans)];
        redaction = applyRedaction(text, spans, enabled);
      }
      update('verify', { status: 'done', ms: performance.now() - t, found: extra.length });
    } catch (e) {
      update('verify', { status: 'error', ms: performance.now() - t, note: (e as Error).message.slice(0, 120) });
    }
  }

  return { redaction, spans, steps, deviceUsed: opts.device };
}
