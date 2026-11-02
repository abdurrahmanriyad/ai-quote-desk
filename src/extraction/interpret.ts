/**
 * Turns what the customer said into something priceable, without the model:
 * catalog matches come from known aliases, and units convert in plain code.
 * Anything that doesn't match stays null, which the pricing engine reports.
 */
import type { Catalog, LineRequest } from '../domain/pricing';
import type { Extraction, RequestedLine } from './schema';

const normalize = (text: string) =>
  ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

type Entry = { code: string; name: string; aliases: string[]; assumedAliases?: string[] };

function editDistance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

const namesOf = (entry: Entry) => [entry.code, entry.name, ...entry.aliases];

/** Close misspellings only, and never for short words, where one letter changes the meaning. */
function closestSpelling(text: string, entries: Entry[]) {
  const stated = text.trim();
  if (stated.length < 6) return null;

  const limit = Math.max(1, Math.floor(stated.length * 0.2));
  const candidates = entries.flatMap((entry) =>
    namesOf(entry).map((alias) => ({ code: entry.code, distance: editDistance(stated, normalize(alias).trim()) })),
  );
  const best = Math.min(...candidates.map((candidate) => candidate.distance));
  const codes = new Set(candidates.filter((c) => c.distance === best).map((c) => c.code));
  return best <= limit && codes.size === 1 ? [...codes][0]! : null;
}

export type CatalogMatch = { code: string | null; note: string | null };

/**
 * An exact name always wins. A close misspelling is tried before partial words,
 * so "stainles steel" can't match plain "steel". Anything assumed carries a note
 * for the reviewer.
 */
export function matchCatalog(text: string | null, entries: Entry[]): CatalogMatch {
  if (text === null) return { code: null, note: null };
  const haystack = normalize(text);
  const nameOf = (code: string) => entries.find((entry) => entry.code === code)!.name;

  const exact = entries.find((entry) => namesOf(entry).some((alias) => normalize(alias) === haystack));
  if (exact) {
    const assumed = exact.assumedAliases?.some((alias) => normalize(alias) === haystack);
    return { code: exact.code, note: assumed ? `Assumed "${text}" means ${exact.name}` : null };
  }

  const spelled = closestSpelling(haystack, entries);
  if (spelled) return { code: spelled, note: `Read "${text}" as ${nameOf(spelled)}` };

  let best: { code: string; length: number } | null = null;
  for (const entry of entries) {
    for (const alias of namesOf(entry)) {
      const needle = normalize(alias);
      if (haystack.includes(needle) && (!best || needle.length > best.length)) {
        best = { code: entry.code, length: needle.length };
      }
    }
  }
  return { code: best?.code ?? null, note: best ? `Read "${text}" as ${nameOf(best.code)}` : null };
}

const MM_PER_UNIT = { mm: 1, cm: 10, m: 1000, in: 25.4 } as const;

function toMm(value: number | null, unit: keyof typeof MM_PER_UNIT | null) {
  if (value === null || unit === null) return null;
  return Math.round(value * MM_PER_UNIT[unit] * 1000) / 1000;
}

export function interpretLine(line: RequestedLine, catalog: Catalog): LineRequest {
  return {
    materialCode: matchCatalog(line.material, catalog.materials).code,
    thicknessMm: toMm(line.thickness, line.thicknessUnit),
    widthMm: toMm(line.width, line.sizeUnit),
    heightMm: toMm(line.height, line.sizeUnit),
    quantity: line.quantity,
    bends: line.bends,
    finishCode: matchCatalog(line.finish, catalog.finishes).code,
  };
}

/** Every assumption made while matching, for the reviewer to confirm. */
export function interpretationNotes(extraction: Extraction, catalog: Catalog): string[] {
  return extraction.lines.flatMap((line, index) =>
    [matchCatalog(line.material, catalog.materials).note, matchCatalog(line.finish, catalog.finishes).note]
      .filter((note): note is string => note !== null)
      .map((note) => `Line ${index + 1}: ${note}`),
  );
}

const flatten = (text: string) => text.replace(/^[>\s]+/gm, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Reasons a reviewer shouldn't trust a line yet. The quote must really be in the request. */
export function verifyEvidence(extraction: Extraction, requestText: string): string[] {
  const source = flatten(requestText);
  const issues: string[] = [];

  extraction.lines.forEach((line, index) => {
    const label = `Line ${index + 1}`;
    const quotes = line.evidence.map(flatten);
    if (quotes.length === 0 || quotes.some((quote) => quote.length === 0 || !source.includes(quote))) {
      issues.push(`${label}: quoted evidence is not in the request`);
    }
    for (const value of [line.thickness, line.width, line.height]) {
      if (value !== null && !new RegExp(`(^|[^0-9.])${value}($|[^0-9])`).test(source)) {
        issues.push(`${label}: ${value} does not appear in the request`);
      }
    }
  });

  return issues;
}
