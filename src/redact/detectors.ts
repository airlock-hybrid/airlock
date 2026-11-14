// Deterministic detectors for structured identifiers. These run first and never depend on a model,
// so emails, phone numbers and ID numbers are caught even when on-device AI is unavailable.

import type { EntityType, Span } from './types';

interface Rule {
  type: EntityType;
  re: RegExp;
  /** Optional check on the matched text (e.g. Luhn for card numbers). */
  accept?: (m: string) => boolean;
}

const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'URL', re: /\bhttps?:\/\/[^\s<>"')\]]+/g },
  { type: 'URL', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: 'ID', re: /\b\d{3}-\d{2}-\d{4}\b/g }, // US SSN
  { type: 'ID', re: /\b(?:\d[ -]?){13,19}\b/g, accept: luhn }, // payment cards
  { type: 'ID', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g }, // IBAN
  {
    type: 'PHONE',
    re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
  },
  { type: 'PHONE', re: /\+\d{1,3}(?:[\s.-]?\d{2,4}){3,5}\b/g },
  // Dates: numeric, ISO, and month-name forms. Years on their own are kept (HIPAA Safe Harbor allows years).
  { type: 'DATE', re: /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b/g },
  { type: 'DATE', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { type: 'DATE', re: new RegExp(`\\b${MONTHS}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`, 'g') },
  { type: 'DATE', re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTHS}\\.?,? \\d{4}\\b`, 'g') },
  // Labelled identifiers: "MRN 00482911", "member ID HX-4471-9920", "policy #A-77812", "account 12345678".
  {
    type: 'ID',
    re: /\b(?:MRN|SSN|DOB|ID|member(?: ID)?|patient(?: ID)?|policy|account|acct|claim|case|ticket|order|invoice|license|licence|passport|plate|NPI)\s*(?:no\.?|number|#|:)?\s*(?:is\s+)?[:#]?\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{4,})\b/gi,
  },
  // Last four digits of a card or account: "card ending 4242".
  { type: 'ID', re: /\b(?:card|account|acct)\s+ending(?:\s+in)?\s+(\d{4})\b/gi },
  // Unlabelled alphanumeric IDs with digits and dashes, e.g. HX-4471-9920 or 7XK-29-0041.
  { type: 'ID', re: /\b[A-Z]{1,4}-?\d{3,}(?:-[A-Z0-9]{2,})+\b/g },
  // US street addresses: "22 Alder Lane", "1600 Pennsylvania Ave NW".
  {
    type: 'ADDRESS',
    re: /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?(?:\s(?:N|S|E|W|NE|NW|SE|SW)\b)?(?:,?\s(?:Apt|Unit|Suite|Ste|#)\s?[A-Z0-9-]+)?/g,
  },
  // City, ST ZIP: "Fresno, CA 93711".
  { type: 'ADDRESS', re: /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?,?\s[A-Z]{2}\s\d{5}(?:-\d{4})?\b/g },
];

/** Run every rule and return raw (possibly overlapping) spans. */
export function detectRules(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      // For labelled IDs, only redact the value, not the label.
      const value = m[1] ?? m[0];
      const start = m.index + m[0].lastIndexOf(value);
      const end = start + value.length;
      const t = text.slice(start, end).replace(/[.,;:]+$/, '');
      if (!t || (rule.accept && !rule.accept(t))) continue;
      spans.push({ start, end: start + t.length, text: t, type: rule.type, source: 'rule' });
    }
  }
  return spans;
}
