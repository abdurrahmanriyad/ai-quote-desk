import { catalog, company, context, getViewer } from '../../../../src/app-context';
import { renderQuotePdf } from '../../../../src/review/quote-pdf';
import { getApprovedQuote } from '../../../../src/review/review';

/** Only an approved quote can become a PDF. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  if (!viewer) return new Response('Not found', { status: 404 });

  const { db } = await context();
  const quote = await getApprovedQuote(db, viewer.tenantId, id).catch(() => null);
  if (!quote) return new Response('Not found', { status: 404 });

  const pdf = await renderQuotePdf({ ...quote, company, catalog });
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="quote-${quote.quoteNumber}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
