/**
 * Turns what the customer said into something priceable, without the model:
 * catalog matches come from known aliases, and units convert in plain code.
 * Anything that doesn't match stays null, which the pricing engine reports.
 */
import type { Catalog, LineRequest } from '../domain/pricing';
import type { Extraction, RequestedLine } from './schema';

const normalize = (text: string) =>
  ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Prefers the longest alias, so "stainless steel" can't match plain "steel". */
export function matchCatalog(
  text: string | null,
  entries: { code: string; name: string; aliases: string[] }[],
): string | null {
  if (text === null) return null;
  const haystack = normalize(text);
  let best: { code: string; length: number } | null = null;

  for (const entry of entries) {
    for (const alias of [entry.code, entry.name, ...entry.aliases]) {
      const needle = normalize(alias);
      if (haystack.includes(needle) && (!best || needle.length > best.length)) {
        best = { code: entry.code, length: needle.length };
      }
    }
  }
  return best?.code ?? null;
}

const MM_PER_UNIT = { mm: 1, cm: 10, m: 1000, in: 25.4 } as const;

function toMm(value: number | null, unit: keyof typeof MM_PER_UNIT | null) {
  if (value === null || unit === null) return null;
  return Math.round(value * MM_PER_UNIT[unit] * 1000) / 1000;
}

export function interpretLine(line: RequestedLine, catalog: Catalog): LineRequest {
  return {
    materialCode: matchCatalog(line.material, catalog.materials),
    thicknessMm: toMm(line.thickness, line.thicknessUnit),
    widthMm: toMm(line.width, line.sizeUnit),
    heightMm: toMm(line.height, line.sizeUnit),
    quantity: line.quantity,
    bends: line.bends,
    finishCode: matchCatalog(line.finish, catalog.finishes),
  };
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
