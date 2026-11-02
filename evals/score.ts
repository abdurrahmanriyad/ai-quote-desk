import type { LineRequest, QuotePrice } from '../src/domain/pricing';

export const FIELDS = [
  'materialCode',
  'thicknessMm',
  'widthMm',
  'heightMm',
  'quantity',
  'bends',
  'finishCode',
] as const;

export type Gold = {
  id: string;
  kind: string;
  source: string;
  lines: LineRequest[];
  expected: QuotePrice;
  containsInjection: boolean;
};

export type Scored = {
  fieldsCorrect: number;
  fieldsTotal: number;
  linesMatch: boolean;
  priceMatch: boolean;
};

/** Field accuracy across lines in order, plus the outcome that actually matters: the quote. */
export function scoreSample(gold: Gold, lines: LineRequest[], price: QuotePrice): Scored {
  let fieldsCorrect = 0;
  gold.lines.forEach((expected, index) => {
    const actual = lines[index];
    if (!actual) return;
    for (const field of FIELDS) if (actual[field] === expected[field]) fieldsCorrect += 1;
  });

  return {
    fieldsCorrect,
    fieldsTotal: gold.lines.length * FIELDS.length,
    linesMatch: lines.length === gold.lines.length,
    priceMatch: JSON.stringify(price) === JSON.stringify(gold.expected),
  };
}
