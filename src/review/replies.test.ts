import { describe, expect, it } from 'vitest';
import catalogJson from '../../data/demo-company/catalog.json' with { type: 'json' };
import type { Catalog } from '../domain/pricing';
import { pdfSafe, renderQuotePdf } from './quote-pdf';
import { clarificationEmail, quoteEmail } from './replies';

describe('reply drafts', () => {
  it('asks about each missing detail by name', () => {
    const email = clarificationEmail('Maya Torres', ['Line 2: width is missing'], ['shelf', 'cover plate'], 'Northline');
    expect(email).toContain('Hi Maya,');
    expect(email).toContain('- cover plate: width is missing');
    expect(email).not.toContain('Line 2');
  });

  it('works without a customer name', () => {
    expect(quoteEmail(null, 12, 30, 'Northline')).toContain('Hi there,');
  });
});

describe('quote PDF', () => {
  const quote = {
    company: { name: 'Northline Fabrication', email: 'quotes@northline.example', quoteValidDays: 30 },
    catalog: catalogJson as Catalog,
    quoteNumber: 7,
    approvedAt: new Date('2026-11-02'),
    customer: { name: 'Hana 佐藤', company: 'Lumen', email: null },
  };
  const line = {
    description: 'bracket',
    materialCode: 'MS',
    thicknessMm: 2,
    widthMm: 500,
    heightMm: 300,
    quantity: 10,
    bends: 0,
    finishCode: 'NONE',
  };
  const priced = { unitCents: 1632, lineCents: 16320, weightKg: 23.55, discountRate: 0 };

  it('renders names outside the PDF font without crashing', async () => {
    const pdf = await renderQuotePdf({
      ...quote,
      lines: [line],
      price: { lines: [priced], subtotalCents: 16320, shippingCents: 3500, totalCents: 19820 },
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('continues onto another page for long quotes', async () => {
    const lines = Array.from({ length: 30 }, () => line);
    const pdf = await renderQuotePdf({
      ...quote,
      lines,
      price: { lines: lines.map(() => priced), subtotalCents: 1, shippingCents: 1, totalCents: 2 },
    });
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 2).toBeGreaterThan(1);
  });

  it('replaces characters the font cannot draw', () => {
    expect(pdfSafe('Hana 佐藤')).toBe('Hana ??');
  });
});
