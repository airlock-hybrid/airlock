import { describe, expect, it } from 'vitest';
import { detectRules, luhn } from './detectors';
import { applyRedaction, harmonize, locate, propagate, rehydrate, resolve } from './merge';
import { ENTITY_TYPES, type Span } from './types';

const ALL = new Set(ENTITY_TYPES);
const MSG =
  'Hi team, patient Maria Delgado (DOB 03/14/1981) called from 415-555-0142 about her refill. She lives at 22 Alder Lane, Fresno, CA 93711 and her member ID is HX-4471-9920. Her daughter Sofia emailed sofia.delgado@examplemail.com saying Dr. Kenji Watanabe at Valley Clinic changed her metformin dose. Maria wants a call back.';

// What Gemini Nano returned for MSG in a live test (structured output).
const NANO = [
  { text: 'Maria Delgado', type: 'PERSON' },
  { text: 'Dr. Kenji Watanabe', type: 'PERSON' },
  { text: 'Valley Clinic', type: 'ORG' },
  { text: 'Fresno CA 93711', type: 'ADDRESS' }, // slightly different from the text (comma) -> must be dropped, rules still cover it
] as const;

function pipeline(text: string) {
  const rule = detectRules(text);
  const nano = NANO.flatMap((c) => locate(text, { ...c, source: 'nano' }));
  const prop = propagate(text, [...rule, ...nano]);
  return applyRedaction(text, [...rule, ...nano, ...prop], ALL);
}

describe('deterministic detectors', () => {
  it('finds structured identifiers', () => {
    const found = detectRules(MSG).map((s) => `${s.type}:${s.text}`);
    expect(found).toContain('EMAIL:sofia.delgado@examplemail.com');
    expect(found).toContain('PHONE:415-555-0142');
    expect(found).toContain('DATE:03/14/1981');
    expect(found).toContain('ID:HX-4471-9920');
    expect(found).toContain('ADDRESS:22 Alder Lane');
    expect(found.some((f) => f.startsWith('ADDRESS:Fresno, CA 93711'))).toBe(true);
  });
  it('validates card numbers with Luhn', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true);
    expect(luhn('4111 1111 1111 1112')).toBe(false);
    expect(detectRules('card 4111-1111-1111-1111 ok').map((s) => s.type)).toContain('ID');
  });
  it('redacts labelled IDs but not the label', () => {
    const s = detectRules('MRN: 00482911 and policy #A77812X');
    expect(s.map((x) => x.text)).toEqual(expect.arrayContaining(['00482911', 'A77812X']));
  });
});

describe('merging and placeholders', () => {
  it('drops model strings that do not occur in the text', () => {
    expect(locate(MSG, { text: 'Fresno CA 93711', type: 'ADDRESS', source: 'nano' })).toHaveLength(0);
    expect(locate(MSG, { text: 'Valley Clinic', type: 'ORG', source: 'nano' })).toHaveLength(1);
  });
  it('prefers longer spans and rules on ties', () => {
    const a: Span = { start: 0, end: 5, text: 'Maria', type: 'PERSON', source: 'propagated' };
    const b: Span = { start: 0, end: 13, text: 'Maria Delgado', type: 'PERSON', source: 'nano' };
    expect(resolve([a, b])).toEqual([b]);
  });
  it('produces a redacted text with no identifiers left and stable placeholders', () => {
    const r = pipeline(MSG);
    for (const leak of ['Maria', 'Delgado', 'Sofia', 'Kenji', 'Watanabe', '415-555', 'Alder', 'Fresno', 'HX-4471', '03/14/1981', 'examplemail', 'Valley Clinic']) {
      expect(r.redacted).not.toContain(leak);
    }
    // Clinical content is kept so the cloud can still help.
    expect(r.redacted).toContain('metformin');
    // "Maria" on her own maps to the same placeholder as "Maria Delgado".
    const maria = r.spans.filter((s) => /^Maria/.test(s.text)).map((s) => s.placeholder);
    expect(new Set(maria).size).toBe(1);
    expect(r.vault[maria[0]]).toBe('Maria Delgado');
    // The daughter, mentioned only by first name and in her email, gets her own placeholder.
    const sofia = r.spans.find((s) => s.text === 'Sofia')!;
    expect(sofia.placeholder).not.toBe(maria[0]);
  });
  it('respects disabled entity types', () => {
    const r = applyRedaction(MSG, detectRules(MSG), new Set(['EMAIL']));
    expect(r.redacted).toContain('415-555-0142');
    expect(r.redacted).not.toContain('examplemail');
  });
});

describe('rehydration', () => {
  it('restores placeholders, tolerating light mangling', () => {
    const vault = { '[PERSON_1]': 'Maria Delgado', '[PHONE_1]': '415-555-0142' };
    const out = rehydrate('Call [PERSON_1] at [ PHONE_1 ] — thanks, [Person 1]. Ignore [PERSON_9].', vault);
    expect(out.text).toBe('Call Maria Delgado at 415-555-0142 — thanks, Maria Delgado. Ignore [PERSON_9].');
    expect(out.restored).toBe(3);
    expect(out.unknown).toEqual(['[PERSON_9]']);
  });
});

describe('more identifier shapes', () => {
  it('catches "account is …" and card last-four', () => {
    const t = detectRules('My account is 77310045 and the card ending 4242 was charged.').map((s) => s.text);
    expect(t).toEqual(expect.arrayContaining(['77310045', '4242']));
  });
});

describe('labelled IDs need a digit', () => {
  it('does not treat a name after a label as an ID', () => {
    const t = detectRules('Hi team, patient Maria Delgado called. Order Tracking is fine. Case 88-1290A open.').map((s) => s.text);
    expect(t).not.toContain('Maria');
    expect(t).not.toContain('Tracking');
    expect(t).toContain('88-1290A');
  });
});

describe('harmonize', () => {
  it('treats a known first name as a person even if the model filed it under places', () => {
    const text = 'From: Priya Raman. Thanks, Priya';
    const spans: Span[] = [
      ...locate(text, { text: 'Priya Raman', type: 'PERSON', source: 'nano' }),
      ...locate(text, { text: 'Priya', type: 'ADDRESS', source: 'nano' }),
    ];
    const h = harmonize(spans);
    const r = applyRedaction(text, [...h, ...propagate(text, h)], ALL);
    expect(r.redacted).toBe('From: [PERSON_1]. Thanks, [PERSON_1]');
  });
});
