// Turns detections into a redacted text with stable placeholders, and restores them afterwards.

import type { Candidate, EntityType, Redaction, Span } from './types';

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sr', 'jr', 'st', 'the', 'of', 'and']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Find every occurrence of a model-proposed string in the text. Strings that do not occur are hallucinations and are dropped. */
export function locate(text: string, c: Candidate): Span[] {
  const needle = c.text.trim();
  if (needle.length < 2) return [];
  const out: Span[] = [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, 'giu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: c.type, source: c.source });
  return out;
}

/** Name parts and email local parts that should also be hidden when they appear on their own ("Maria" after "Maria Delgado"). */
export function nameTokens(spans: Span[]): Map<string, string> {
  const tokenToPerson = new Map<string, string>();
  for (const s of spans) {
    if (s.type === 'PERSON') {
      for (const tok of s.text.split(/[\s.,'-]+/)) {
        const k = tok.toLowerCase();
        if (tok.length >= 3 && /^\p{Lu}/u.test(tok) && !TITLES.has(k) && !tokenToPerson.has(k)) tokenToPerson.set(k, norm(s.text));
      }
    }
  }
  for (const s of spans) {
    if (s.type === 'EMAIL') {
      const local = s.text.split('@')[0];
      for (const tok of local.split(/[._+-]+/)) {
        const k = tok.toLowerCase();
        if (k.length >= 3 && /^[a-z]+$/.test(k) && !tokenToPerson.has(k)) tokenToPerson.set(k, `email:${k}`);
      }
    }
  }
  return tokenToPerson;
}

export function propagate(text: string, spans: Span[]): Span[] {
  const tokens = nameTokens(spans);
  const out: Span[] = [];
  for (const [tok] of tokens) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}@.])${escapeRe(tok)}(?![\\p{L}\\p{N}@])`, 'giu');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // Only capitalized standalone mentions are names ("Sofia"), not ordinary words ("sofia" inside a sentence is rare but possible).
      if (!/^\p{Lu}/u.test(m[0])) continue;
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: 'PERSON', source: 'propagated' });
    }
  }
  return out;
}

/** Model spans that repeat a known person's name (or part of it) are people, whatever list the model put them in. */
export function harmonize(spans: Span[]): Span[] {
  const people = spans.filter((s) => s.type === 'PERSON');
  const tokens = nameTokens(people);
  const full = new Set(people.map((s) => norm(s.text)));
  return spans.map((s) =>
    s.type !== 'PERSON' && (s.source === 'nano' || s.source === 'verify') && (full.has(norm(s.text)) || tokens.has(norm(s.text))) ? { ...s, type: 'PERSON' } : s,
  );
}

const PRIORITY: Record<string, number> = { rule: 4, user: 5, nano: 3, verify: 2, propagated: 1 };

/** Resolve overlaps: longer spans win; on equal length, deterministic rules win over model guesses. */
export function resolve(spans: Span[]): Span[] {
  const sorted = [...spans].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || (PRIORITY[b.source] ?? 0) - (PRIORITY[a.source] ?? 0) || a.start - b.start,
  );
  const taken: Span[] = [];
  for (const s of sorted) {
    if (taken.some((t) => s.start < t.end && t.start < s.end)) continue;
    taken.push(s);
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** Build the redacted text and the local vault of placeholder -> original value. */
export function applyRedaction(text: string, spans: Span[], enabled: Set<EntityType>): Redaction {
  const kept = resolve(spans.filter((s) => enabled.has(s.type)));
  const tokens = nameTokens(kept);
  const keyFor = (s: Span) => {
    if (s.type === 'PERSON') {
      const whole = norm(s.text);
      // A standalone first or last name maps to the full name it came from.
      return 'PERSON:' + (tokens.get(whole) ?? whole);
    }
    return `${s.type}:${norm(s.text)}`;
  };
  const keyToPh = new Map<string, string>();
  const counters: Partial<Record<EntityType, number>> = {};
  const vault: Record<string, string> = {};
  const outSpans: Redaction['spans'] = [];
  let redacted = '';
  let cursor = 0;
  for (const s of kept) {
    const key = keyFor(s);
    let ph = keyToPh.get(key);
    if (!ph) {
      counters[s.type] = (counters[s.type] ?? 0) + 1;
      ph = `[${s.type}_${counters[s.type]}]`;
      keyToPh.set(key, ph);
      vault[ph] = s.text;
    } else if (s.text.length > vault[ph].length) {
      vault[ph] = s.text; // prefer the fullest form ("Maria Delgado" over "Maria")
    }
    redacted += text.slice(cursor, s.start) + ph;
    cursor = s.end;
    outSpans.push({ ...s, placeholder: ph });
  }
  redacted += text.slice(cursor);
  return { redacted, vault, spans: outSpans, counts: counters };
}

const PH_RE = /\[\s*(PERSON|EMAIL|PHONE|ADDRESS|DATE|ID|URL|ORG)[\s_-]*(\d+)\s*\]/gi;

/** Put real values back into a model answer. Tolerates small placeholder mangling such as "[Person 1]". */
export function rehydrate(answer: string, vault: Record<string, string>): { text: string; restored: number; unknown: string[] } {
  let restored = 0;
  const unknown: string[] = [];
  const text = answer.replace(PH_RE, (whole, type: string, n: string) => {
    const ph = `[${type.toUpperCase()}_${n}]`;
    if (ph in vault) {
      restored++;
      return vault[ph];
    }
    unknown.push(whole);
    return whole;
  });
  return { text, restored, unknown };
}

/** Placeholders the model received but did not return are fine; placeholders it invented are flagged. */
export function placeholdersIn(s: string): string[] {
  return [...s.matchAll(PH_RE)].map((m) => `[${m[1].toUpperCase()}_${m[2]}]`);
}
