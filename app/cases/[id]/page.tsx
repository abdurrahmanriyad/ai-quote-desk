import Link from 'next/link';
import { notFound } from 'next/navigation';
import { approve, saveLines } from '../../actions';
import { catalog, company, context, requireViewer } from '../../../src/app-context';
import { money } from '../../../src/review/quote-pdf';
import { clarificationEmail, quoteEmail } from '../../../src/review/replies';
import { getReview } from '../../../src/review/review';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NUMERIC = [
  ['quantity', 'Qty'],
  ['thicknessMm', 'Thickness (mm)'],
  ['widthMm', 'Width (mm)'],
  ['heightMm', 'Height (mm)'],
  ['bends', 'Bends'],
] as const;

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!UUID.test(id)) notFound();

  const { tenantId, canEdit } = await requireViewer();
  const { db, storage } = await context();
  const review = await getReview(db, tenantId, id);
  if (!review) notFound();

  const working = review.status === 'received' || review.status === 'processing';
  const draft = review.draft;
  const open = review.status === 'needs_review';
  const editable = open && canEdit;
  const price = draft?.price;
  const textSource = review.document && !/pdf|image/.test(review.document.mediaType);
  const sourceText = textSource
    ? (
        await storage.get(
          (await db.query<{ storage_key: string }>('SELECT storage_key FROM case_documents WHERE case_id = $1 AND tenant_id = $2', [id, tenantId]))
            .rows[0]!.storage_key,
        )
      ).toString('utf8')
    : null;

  return (
    <>
      {working && <meta httpEquiv="refresh" content="2" />}
      <p className="crumb"><Link href="/">← All requests</Link></p>
      <div className="heading">
        <div>
          <h1>{draft?.customer.company ?? draft?.customer.name ?? review.document?.filename ?? 'Request'}</h1>
          <p className="muted">{review.document?.filename}{draft ? ` · read by ${draft.model}` : ''}</p>
        </div>
        {review.approved && <span className="status approved">Approved · Quote {review.approved.quoteNumber}</span>}
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {working && <p className="empty">Reading the request…</p>}
      {review.status === 'failed' && <p className="alert" role="alert">This request failed: {review.failureReason}</p>}

      <div className="review">
        <section aria-labelledby="source">
          <h2 id="source">Customer request</h2>
          {sourceText !== null ? (
            <pre className="source">{sourceText}</pre>
          ) : review.document?.mediaType.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="source-file" src={`/cases/${id}/source`} alt="The customer's uploaded request" />
          ) : (
            <iframe className="source-file" src={`/cases/${id}/source`} title="The customer's uploaded request" sandbox="" />
          )}
        </section>

        {draft && price && (
          <section aria-labelledby="draft">
            <h2 id="draft">{review.approved ? 'Approved quote' : 'Draft quote'}</h2>

            {draft.reviewIssues.length > 0 && (
              <div className="warnings">
                <strong>Check before approving</strong>
                <ul>{draft.reviewIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
              </div>
            )}

            <form action={saveLines.bind(null, id, draft.lines.length)}>
              <fieldset disabled={!editable}>
                {draft.lines.map((line, index) => (
                  <div className="line" key={index}>
                    <h3>
                      {line.description}
                      {price.ok && <span>{money(price.lines[index]!.lineCents)}</span>}
                    </h3>
                    <div className="fields">
                      <label>
                        Material
                        <select name={`materialCode-${index}`} defaultValue={line.materialCode ?? ''} className={line.materialCode ? '' : 'missing'}>
                          <option value="">Not stated</option>
                          {catalog.materials.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Finish
                        <select name={`finishCode-${index}`} defaultValue={line.finishCode ?? ''} className={line.finishCode ? '' : 'missing'}>
                          <option value="">Not stated</option>
                          {catalog.finishes.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}
                        </select>
                      </label>
                      {NUMERIC.map(([field, label]) => (
                        <label key={field}>
                          {label}
                          <input type="number" step="any" min="0" name={`${field}-${index}`} defaultValue={line[field] ?? ''} className={line[field] === null ? 'missing' : ''} />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {editable && <button className="secondary">Save and reprice</button>}
              </fieldset>
            </form>

            {price.ok ? (
              <dl className="totals">
                <div><dt>Subtotal</dt><dd>{money(price.subtotalCents)}</dd></div>
                <div><dt>Shipping</dt><dd>{price.shippingCents === null ? 'Freight quote needed' : money(price.shippingCents)}</dd></div>
                <div className="grand"><dt>Total</dt><dd>{price.totalCents === null ? '—' : money(price.totalCents)}</dd></div>
              </dl>
            ) : (
              <div className="warnings">
                <strong>Can't price this yet</strong>
                <ul>{price.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
              </div>
            )}

            {editable && price.ok && price.totalCents !== null && (
              <form action={approve.bind(null, id)} className="approve">
                {draft.reviewIssues.length > 0 && (
                  <label className="check"><input type="checkbox" name="acknowledged" required /> I've checked the warnings above</label>
                )}
                <button>Approve quote</button>
              </form>
            )}

            {open && !price.ok && (
              <details open>
                <summary>Suggested reply to the customer</summary>
                <pre className="reply">{clarificationEmail(draft.customer.name, price.problems, draft.lines.map((line) => line.description), company.name)}</pre>
              </details>
            )}

            {review.approved && (
              <>
                <p><a className="button" href={`/cases/${id}/quote.pdf`}>Download quote PDF</a></p>
                <details open>
                  <summary>Reply to send with it</summary>
                  <pre className="reply">{quoteEmail(draft.customer.name, review.approved.quoteNumber, company.quoteValidDays, company.name)}</pre>
                </details>
                <p className="muted">Quote Desk doesn't send email yet, so nothing has gone to the customer.</p>
              </>
            )}
          </section>
        )}
      </div>
    </>
  );
}
