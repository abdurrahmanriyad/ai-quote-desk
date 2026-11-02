import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Catalog } from '../domain/pricing';
import type { Extraction } from '../extraction/schema';
import type { PricedLine } from '../domain/pricing';
import type { QuoteLine } from './review';

export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** PDF standard fonts cover Western characters only; customer text can contain anything. */
export const pdfSafe = (text: string) => text.replace(/[^\x20-\x7e -ÿ]/g, '?');

type QuoteInput = {
  company: { name: string; email: string; quoteValidDays: number };
  catalog: Catalog;
  quoteNumber: number;
  approvedAt: Date;
  customer: Extraction['customer'];
  lines: QuoteLine[];
  price: { lines: PricedLine[]; subtotalCents: number; shippingCents: number; totalCents: number };
};

const INK = rgb(0.11, 0.1, 0.09);
const FAINT = rgb(0.42, 0.39, 0.35);
const LEFT = 50;
const RIGHT = 562;
const ROW_HEIGHT = 34;

export async function renderQuotePdf(input: QuoteInput) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Quote ${input.quoteNumber}`);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([612, 792]);

  const text = (target: PDFPage, value: string, x: number, y: number, size = 10, font: PDFFont = regular, color = INK) =>
    target.drawText(pdfSafe(value), { x, y, size, font, color });
  const right = (target: PDFPage, value: string, x: number, y: number, font: PDFFont = regular) =>
    text(target, value, x - font.widthOfTextAtSize(pdfSafe(value), 10), y, 10, font);

  text(page, input.company.name, LEFT, 730, 18, bold);
  text(page, input.company.email, LEFT, 712, 10, regular, FAINT);
  right(page, `Quote ${input.quoteNumber}`, RIGHT, 730, bold);
  right(page, input.approvedAt.toISOString().slice(0, 10), RIGHT, 716);
  right(page, `Valid for ${input.company.quoteValidDays} days`, RIGHT, 702);

  const customer = [input.customer.company, input.customer.name, input.customer.email].filter(Boolean);
  text(page, 'Prepared for', LEFT, 672, 9, regular, FAINT);
  customer.forEach((value, index) => text(page, value!, LEFT, 656 - index * 14));

  const header = (target: PDFPage, y: number) => {
    text(target, 'Item', LEFT, y, 9, bold);
    right(target, 'Qty', 400, y, bold);
    right(target, 'Unit', 480, y, bold);
    right(target, 'Total', RIGHT, y, bold);
    target.drawLine({ start: { x: LEFT, y: y - 6 }, end: { x: RIGHT, y: y - 6 }, thickness: 0.5, color: FAINT });
  };

  let y = 590;
  header(page, y);
  y -= 26;

  input.lines.forEach((line, index) => {
    if (y < 130) {
      page = pdf.addPage([612, 792]);
      y = 730;
      header(page, y);
      y -= 26;
    }
    const priced = input.price.lines[index]!;
    const material = input.catalog.materials.find((m) => m.code === line.materialCode)?.name ?? '';
    const finish = input.catalog.finishes.find((f) => f.code === line.finishCode)?.name ?? '';
    text(page, line.description, LEFT, y);
    text(page, `${line.thicknessMm} mm ${material}, ${line.widthMm} x ${line.heightMm} mm, ${line.bends} bends, ${finish}`, LEFT, y - 13, 8, regular, FAINT);
    right(page, String(line.quantity), 400, y);
    right(page, money(priced.unitCents), 480, y);
    right(page, money(priced.lineCents), RIGHT, y);
    y -= ROW_HEIGHT;
  });

  page.drawLine({ start: { x: 340, y: y + 8 }, end: { x: RIGHT, y: y + 8 }, thickness: 0.5, color: FAINT });
  text(page, 'Subtotal', 340, y - 8);
  right(page, money(input.price.subtotalCents), RIGHT, y - 8);
  text(page, 'Shipping', 340, y - 24);
  right(page, money(input.price.shippingCents), RIGHT, y - 24);
  text(page, 'Total', 340, y - 44, 12, bold);
  right(page, money(input.price.totalCents), RIGHT, y - 44, bold);

  return Buffer.from(await pdf.save());
}
