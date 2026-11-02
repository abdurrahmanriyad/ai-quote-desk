/**
 * The human step. A person can correct a draft and approve it, and these rules
 * hold no matter what the screen does: prices always come from the pricing
 * engine, and nothing incomplete or unacknowledged can be approved.
 */
import { transaction, type Db } from '../db/index';
import {
  priceQuote,
  type Catalog,
  type LineRequest,
  type PricingRules,
  type QuotePrice,
} from '../domain/pricing';
import { recordEvent, type CaseStatus } from '../intake/cases';
import type { Extraction } from '../extraction/schema';

export class ReviewError extends Error {}

export type QuoteLine = LineRequest & { description: string };

export type Review = {
  id: string;
  status: CaseStatus;
  failureReason: string | null;
  createdAt: Date;
  document: { filename: string; mediaType: string } | null;
  draft: {
    customer: Extraction['customer'];
    lines: QuoteLine[];
    price: QuotePrice;
    reviewIssues: string[];
    model: string;
  } | null;
  approved: { quoteNumber: number; approvedBy: string; approvedAt: Date } | null;
};

type DraftRow = {
  extraction: Extraction;
  lines: LineRequest[];
  price: QuotePrice;
  review_issues: string[];
  model: string;
};

const withDescriptions = (row: DraftRow): QuoteLine[] =>
  row.lines.map((line, index) => ({
    ...line,
    description: row.extraction.lines[index]?.description ?? `Line ${index + 1}`,
  }));

export async function listCases(db: Db, tenantId: string) {
  const { rows } = await db.query<{
    id: string;
    status: CaseStatus;
    created_at: Date;
    filename: string | null;
    customer: string | null;
    total_cents: string | null;
    issues: number | null;
  }>(
    `SELECT q.id, q.status, q.created_at, doc.filename,
            coalesce(d.extraction #>> '{customer,company}', d.extraction #>> '{customer,name}') AS customer,
            d.price ->> 'totalCents' AS total_cents,
            jsonb_array_length(d.review_issues) AS issues
     FROM quote_cases q
     LEFT JOIN case_drafts d ON d.case_id = q.id
     LEFT JOIN LATERAL (
       SELECT filename FROM case_documents WHERE case_id = q.id ORDER BY created_at LIMIT 1
     ) doc ON true
     WHERE q.tenant_id = $1
     ORDER BY q.created_at DESC
     LIMIT 100`,
    [tenantId],
  );
  return rows;
}

export async function getReview(db: Db, tenantId: string, caseId: string): Promise<Review | null> {
  const { rows } = await db.query<{
    id: string;
    status: CaseStatus;
    failure_reason: string | null;
    created_at: Date;
    filename: string | null;
    media_type: string | null;
    draft: DraftRow | null;
    quote_number: string | null;
    approved_by: string | null;
    approved_at: Date | null;
  }>(
    `SELECT q.id, q.status, q.failure_reason, q.created_at, doc.filename, doc.media_type,
            CASE WHEN d.case_id IS NULL THEN NULL ELSE jsonb_build_object(
              'extraction', d.extraction, 'lines', d.lines, 'price', d.price,
              'review_issues', d.review_issues, 'model', d.model) END AS draft,
            a.quote_number, a.approved_by, a.approved_at
     FROM quote_cases q
     LEFT JOIN case_drafts d ON d.case_id = q.id
     LEFT JOIN approved_quotes a ON a.case_id = q.id
     LEFT JOIN LATERAL (
       SELECT filename, media_type FROM case_documents WHERE case_id = q.id ORDER BY created_at LIMIT 1
     ) doc ON true
     WHERE q.id = $1 AND q.tenant_id = $2`,
    [caseId, tenantId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    document: row.filename ? { filename: row.filename, mediaType: row.media_type! } : null,
    draft: row.draft
      ? {
          customer: row.draft.extraction.customer,
          lines: withDescriptions(row.draft),
          price: row.draft.price,
          reviewIssues: row.draft.review_issues,
          model: row.draft.model,
        }
      : null,
    approved: row.quote_number
      ? {
          quoteNumber: Number(row.quote_number),
          approvedBy: row.approved_by!,
          approvedAt: row.approved_at!,
        }
      : null,
  };
}

async function lockForReview(tx: Parameters<Parameters<typeof transaction>[1]>[0], tenantId: string, caseId: string) {
  const { rows } = await tx.query<{ status: CaseStatus } & DraftRow>(
    `SELECT q.status, d.extraction, d.lines, d.price, d.review_issues, d.model
     FROM quote_cases q JOIN case_drafts d ON d.case_id = q.id
     WHERE q.id = $1 AND q.tenant_id = $2
     FOR UPDATE OF q`,
    [caseId, tenantId],
  );
  const row = rows[0];
  if (!row) throw new ReviewError('Quote not found');
  if (row.status !== 'needs_review') throw new ReviewError('This quote is no longer open for review');
  return row;
}

/** Saves a reviewer's corrections. The price is recalculated, never accepted from the form. */
export async function saveCorrections(
  deps: { db: Db; catalog: Catalog; rules: PricingRules },
  input: { tenantId: string; caseId: string; lines: LineRequest[]; reviewer: string },
) {
  return transaction(deps.db, async (tx) => {
    const row = await lockForReview(tx, input.tenantId, input.caseId);
    if (input.lines.length !== row.lines.length) throw new ReviewError('Line items do not match the draft');

    const price = priceQuote(input.lines, deps.catalog, deps.rules);
    await tx.query('UPDATE case_drafts SET lines = $3, price = $4 WHERE case_id = $1 AND tenant_id = $2', [
      input.caseId,
      input.tenantId,
      JSON.stringify(input.lines),
      JSON.stringify(price),
    ]);
    await recordEvent(tx, input.tenantId, input.caseId, 'draft.corrected', {
      reviewer: input.reviewer,
      before: row.lines,
      after: input.lines,
    });
    return price;
  });
}

export async function approveQuote(
  db: Db,
  input: { tenantId: string; caseId: string; reviewer: string; acknowledgedIssues: boolean },
) {
  return transaction(db, async (tx) => {
    const row = await lockForReview(tx, input.tenantId, input.caseId);

    if (!row.price.ok) throw new ReviewError('Resolve the missing details before approving');
    if (row.price.totalCents === null) throw new ReviewError('This order needs a freight quote before approval');
    if (row.review_issues.length > 0 && !input.acknowledgedIssues) {
      throw new ReviewError('Confirm you have checked the warnings before approving');
    }

    await tx.query(
      `INSERT INTO approved_quotes (case_id, tenant_id, lines, price, customer, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.caseId,
        input.tenantId,
        JSON.stringify(withDescriptions(row)),
        JSON.stringify(row.price),
        JSON.stringify(row.extraction.customer),
        input.reviewer,
      ],
    );
    await tx.query(
      `UPDATE quote_cases SET status = 'approved', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [input.caseId, input.tenantId],
    );
    await recordEvent(tx, input.tenantId, input.caseId, 'quote.approved', {
      reviewer: input.reviewer,
      acknowledgedIssues: row.review_issues,
      totalCents: row.price.totalCents,
    });
  });
}

export async function getApprovedQuote(db: Db, tenantId: string, caseId: string) {
  const { rows } = await db.query<{
    quote_number: string;
    lines: QuoteLine[];
    price: Extract<QuotePrice, { ok: true; shippingCents: number }>;
    customer: Extraction['customer'];
    approved_at: Date;
  }>(
    `SELECT quote_number, lines, price, customer, approved_at FROM approved_quotes
     WHERE case_id = $1 AND tenant_id = $2`,
    [caseId, tenantId],
  );
  const row = rows[0];
  return row
    ? {
        quoteNumber: Number(row.quote_number),
        lines: row.lines,
        price: row.price,
        customer: row.customer,
        approvedAt: row.approved_at,
      }
    : null;
}
