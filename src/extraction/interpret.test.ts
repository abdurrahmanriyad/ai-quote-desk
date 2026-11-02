import { describe, expect, it } from 'vitest';
import catalogJson from '../../data/demo-company/catalog.json' with { type: 'json' };
import type { Catalog } from '../domain/pricing';
import { interpretLine, matchCatalog, verifyEvidence } from './interpret';
import type { Extraction, RequestedLine } from './schema';

const catalog = catalogJson as Catalog;

const line = (overrides: Partial<RequestedLine> = {}): RequestedLine => ({
  description: 'bracket',
  quantity: 10,
  material: 'stainless steel',
  thickness: 2,
  thicknessUnit: 'mm',
  width: 50,
  height: 30,
  sizeUnit: 'cm',
  bends: 0,
  finish: 'powder coated',
  evidence: ['10 brackets in stainless steel 2mm, 50 by 30 cm, flat, powder coated'],
  ...overrides,
});

const extraction = (lines: RequestedLine[]): Extraction => ({
  customer: { name: null, company: null, email: null },
  lines,
  containsInstructionsToSoftware: false,
});

describe('matchCatalog', () => {
  const code = (text: string | null, entries: Parameters<typeof matchCatalog>[1] = catalog.materials) =>
    matchCatalog(text, entries).code;

  it('prefers the most specific name', () => {
    expect(code('stainless steel')).toBe('SS304');
    expect(code('Mild Steel')).toBe('MS');
    expect(code('5052 aluminium')).toBe('AL5052');
  });

  it('matches whole words only', () => {
    expect(code('rawhide', catalog.finishes)).toBeNull();
    expect(code('steelish')).toBeNull();
  });

  it('leaves unknown and missing values empty', () => {
    expect(code('titanium')).toBeNull();
    expect(code('brass')).toBeNull();
    expect(code(null)).toBeNull();
  });

  it('never turns a misspelled stainless into mild steel', () => {
    expect(matchCatalog('stainles steel', catalog.materials)).toEqual({
      code: 'SS304',
      note: 'Read "stainles steel" as Stainless steel 304',
    });
  });

  it('fixes close misspellings, and tells the reviewer', () => {
    expect(matchCatalog('aluminun', catalog.materials).code).toBe('AL5052');
    expect(matchCatalog('powdercote', catalog.finishes).code).toBe('POWDER');
    expect(matchCatalog('mild steal', catalog.materials).note).toContain('Mild steel');
  });

  it('does not guess at short words', () => {
    expect(code('ram', catalog.finishes)).toBeNull();
    expect(code('alo')).toBeNull();
  });

  it('flags the vague word "steel" as an assumption', () => {
    expect(matchCatalog('steel', catalog.materials)).toEqual({
      code: 'MS',
      note: 'Assumed "steel" means Mild steel',
    });
  });

  it('adds no note for an exact name', () => {
    expect(matchCatalog('mild steel', catalog.materials).note).toBeNull();
  });
});

describe('interpretLine', () => {
  it('converts stated units to millimetres', () => {
    expect(interpretLine(line(), catalog)).toMatchObject({
      materialCode: 'SS304',
      thicknessMm: 2,
      widthMm: 500,
      heightMm: 300,
      finishCode: 'POWDER',
    });
    expect(interpretLine(line({ width: 12, height: 6, sizeUnit: 'in' }), catalog)).toMatchObject({
      widthMm: 304.8,
      heightMm: 152.4,
    });
  });

  it('never assumes a unit', () => {
    expect(interpretLine(line({ sizeUnit: null, thicknessUnit: null }), catalog)).toMatchObject({
      thicknessMm: null,
      widthMm: null,
      heightMm: null,
    });
  });
});

describe('verifyEvidence', () => {
  const request = `sorry, make it\n\n> 10 brackets in stainless steel 2mm, 50 by 30 cm,\n> flat, powder coated`;

  it('accepts a quote across wrapped and quoted lines', () => {
    expect(verifyEvidence(extraction([line()]), request)).toEqual([]);
  });

  it('flags a quote that is not in the request', () => {
    expect(verifyEvidence(extraction([line({ evidence: ['made up'] })]), request)).toEqual([
      'Line 1: quoted evidence is not in the request',
    ]);
  });

  it('checks every quote and requires at least one', () => {
    const issue = ['Line 1: quoted evidence is not in the request'];
    expect(verifyEvidence(extraction([line({ evidence: ['sorry, make it', 'made up'] })]), request)).toEqual(issue);
    expect(verifyEvidence(extraction([line({ evidence: [] })]), request)).toEqual(issue);
  });

  it('flags a dimension the request never states', () => {
    expect(verifyEvidence(extraction([line({ width: 75 })]), request)).toEqual([
      'Line 1: 75 does not appear in the request',
    ]);
  });
});
