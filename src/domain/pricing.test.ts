import { describe, expect, it } from 'vitest';
import catalogJson from '../../data/demo-company/catalog.json' with { type: 'json' };
import rulesJson from '../../data/demo-company/pricing.json' with { type: 'json' };
import { priceQuote, type Catalog, type LineRequest, type PricingRules } from './pricing.js';

const catalog = catalogJson as Catalog;
const rules = rulesJson as PricingRules;

const line = (overrides: Partial<LineRequest> = {}): LineRequest => ({
  materialCode: 'MS',
  thicknessMm: 2,
  widthMm: 500,
  heightMm: 300,
  quantity: 10,
  bends: 2,
  finishCode: 'NONE',
  ...overrides,
});

const priced = (lines: LineRequest[]) => {
  const result = priceQuote(lines, catalog, rules);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result;
};

describe('priceQuote', () => {
  it('prices a known part exactly', () => {
    // 0.15 m² × 2 mm × 7850 kg/m³ = 2.355 kg. Material 379.155¢, cutting 133.333¢,
    // bends 180¢, setup 450¢ per unit → cost 1142.488¢; ÷ 0.7 = 1632.126¢ → 1632¢.
    // Total weight 23.55 kg falls in the first shipping band.
    const result = priced([line()]);
    expect(result.lines[0]?.unitCents).toBe(1632);
    expect(result.subtotalCents).toBe(16320);
    expect(result.shippingCents).toBe(3500);
    expect(result.totalCents).toBe(19820);
  });

  it('makes every printed line multiply out exactly', () => {
    const result = priced([line({ quantity: 37 }), line({ materialCode: 'SS304', quantity: 3 })]);
    for (const [index, item] of result.lines.entries()) {
      const quantity = [37, 3][index]!;
      expect(item.lineCents).toBe(item.unitCents * quantity);
    }
    expect(result.subtotalCents).toBe(result.lines.reduce((sum, item) => sum + item.lineCents, 0));
  });

  it.each([
    [24, 0],
    [25, 0.05],
    [99, 0.05],
    [100, 0.1],
    [499, 0.1],
    [500, 0.15],
  ])('applies the quantity break at %i', (quantity, discountRate) => {
    expect(priced([line({ quantity })]).lines[0]?.discountRate).toBe(discountRate);
  });

  it('adds finish cost by area', () => {
    const raw = priced([line()]).lines[0]!.unitCents;
    const coated = priced([line({ finishCode: 'POWDER' })]).lines[0]!.unitCents;
    expect(coated - raw).toBe(Math.round((0.15 * 2800) / 0.7));
  });

  it('accepts a part with no bends', () => {
    expect(priced([line({ bends: 0 })]).lines[0]?.unitCents).toBeGreaterThan(0);
  });

  it.each([
    ['materialCode', 'material is missing'],
    ['thicknessMm', 'thickness is missing'],
    ['widthMm', 'width is missing'],
    ['heightMm', 'height is missing'],
    ['quantity', 'quantity is missing'],
    ['bends', 'bend count is missing'],
    ['finishCode', 'finish is missing'],
  ])('refuses to price without %s', (field, message) => {
    const result = priceQuote([line({ [field]: null })], catalog, rules);
    expect(result).toEqual({ ok: false, problems: [`Line 1: ${message}`] });
  });

  it('reports every problem at once, across lines', () => {
    const result = priceQuote([line({ widthMm: null }), line({ quantity: null })], catalog, rules);
    expect(result).toEqual({
      ok: false,
      problems: ['Line 1: width is missing', 'Line 2: quantity is missing'],
    });
  });

  it('rejects stock and values the shop cannot supply', () => {
    const cases: [Partial<LineRequest>, string][] = [
      [{ materialCode: 'TITANIUM' }, 'Line 1: unknown material TITANIUM'],
      [{ materialCode: 'SS304', thicknessMm: 5 }, 'Line 1: 5 mm Stainless steel 304 is not stocked'],
      [{ finishCode: 'CHROME' }, 'Line 1: unknown finish CHROME'],
      [{ quantity: 2.5 }, 'Line 1: quantity must be whole'],
      [{ quantity: 0 }, 'Line 1: quantity is missing'],
      [{ widthMm: -10 }, 'Line 1: width is missing'],
      [{ bends: -1 }, 'Line 1: bend count must be a whole number'],
    ];
    for (const [overrides, message] of cases) {
      expect(priceQuote([line(overrides)], catalog, rules)).toEqual({ ok: false, problems: [message] });
    }
  });

  it('refuses an empty request', () => {
    expect(priceQuote([], catalog, rules)).toEqual({
      ok: false,
      problems: ['The request has no line items'],
    });
  });

  it('picks the shipping band by total weight', () => {
    expect(priced([line({ widthMm: 1000, heightMm: 1000, quantity: 5 })]).shippingCents).toBe(9500);
  });

  it('asks for a freight quote instead of inventing a price above the top band', () => {
    const result = priced([line({ widthMm: 2000, heightMm: 1000, thicknessMm: 6, quantity: 10 })]);
    expect(result).toMatchObject({ needsFreightQuote: true, shippingCents: null, totalCents: null });
  });
});
