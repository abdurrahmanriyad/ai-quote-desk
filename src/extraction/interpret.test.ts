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
  it('prefers the most specific alias', () => {
    expect(matchCatalog('stainless steel', catalog.materials)).toBe('SS304');
    expect(matchCatalog('Mild Steel', catalog.materials)).toBe('MS');
    expect(matchCatalog('5052 aluminium', catalog.materials)).toBe('AL5052');
  });

  it('matches whole words only', () => {
    expect(matchCatalog('rawhide', catalog.finishes)).toBeNull();
    expect(matchCatalog('steelish', catalog.materials)).toBeNull();
  });

  it('leaves unknown and missing values empty', () => {
    expect(matchCatalog('titanium', catalog.materials)).toBeNull();
    expect(matchCatalog(null, catalog.materials)).toBeNull();
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
