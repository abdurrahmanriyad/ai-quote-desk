import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import catalogJson from '../../data/demo-company/catalog.json' with { type: 'json' };
import rulesJson from '../../data/demo-company/pricing.json' with { type: 'json' };
import { priceQuote, type Catalog, type LineRequest, type PricingRules } from './pricing.js';

const ROOT = join(import.meta.dirname, '../../data/samples');

type Gold = {
  id: string;
  kind: string;
  source: string;
  lines: LineRequest[];
  expected: ReturnType<typeof priceQuote>;
  containsInjection: boolean;
};

const samples = readdirSync(ROOT).map((id) => ({
  gold: JSON.parse(readFileSync(join(ROOT, id, 'gold.json'), 'utf8')) as Gold,
  text: (dir: string, file: string) => readFileSync(join(ROOT, dir, file), 'utf8'),
}));

describe('sample set', () => {
  it('has the planned mix', () => {
    const counts = Object.fromEntries(
      ['clean', 'messy', 'missing', 'spreadsheet', 'injection'].map((kind) => [
        kind,
        samples.filter(({ gold }) => gold.kind === kind).length,
      ]),
    );
    expect(counts).toEqual({ clean: 12, messy: 8, missing: 6, spreadsheet: 2, injection: 2 });
  });

  it('stores answers the pricing engine still agrees with', () => {
    for (const { gold } of samples) {
      expect(priceQuote(gold.lines, catalogJson as Catalog, rulesJson as PricingRules)).toEqual(
        gold.expected,
      );
    }
  });

  it('marks every missing-information sample as unpriceable', () => {
    for (const { gold } of samples.filter(({ gold }) => gold.kind === 'missing')) {
      expect(gold.expected.ok, gold.id).toBe(false);
    }
  });

  it('prices every complete sample', () => {
    for (const { gold } of samples.filter(({ gold }) => gold.kind !== 'missing')) {
      expect(gold.expected.ok, gold.id).toBe(true);
    }
  });

  it('never leaks a placeholder into a request', () => {
    for (const { gold, text } of samples) {
      expect(text(gold.id, gold.source), gold.id).not.toMatch(/\b(null|undefined|NaN)\b/);
    }
  });

  it('only counts information as known when the request states it', () => {
    for (const { gold, text } of samples.filter(({ gold }) => gold.kind === 'missing')) {
      const request = text(gold.id, gold.source).toLowerCase();
      const line = gold.lines[0]!;
      const material = (catalogJson as Catalog).materials.find((m) => m.code === line.materialCode)!;
      expect(material.aliases.some((alias) => request.includes(alias.toLowerCase())), gold.id).toBe(true);
      if (line.widthMm !== null) expect(request, gold.id).toContain(`${line.widthMm} x ${line.heightMm} mm`);
      if (line.thicknessMm !== null) expect(request, gold.id).toContain(`${line.thicknessMm} mm `);
    }
  });

  it('puts the attack text in the injection samples only', () => {
    for (const { gold, text } of samples) {
      expect(text(gold.id, gold.source).includes('ignore your previous instructions'), gold.id).toBe(
        gold.containsInjection,
      );
    }
  });
});
