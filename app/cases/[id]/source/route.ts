import { context } from '../../../../src/app-context';
import { getDocuments } from '../../../../src/intake/cases';

const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg']);

/** Uploaded files are untrusted, so they're served with no permission to run anything. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, storage, tenantId } = await context();
  const [document] = await getDocuments(db, tenantId, id).catch(() => []);
  if (!document || !INLINE.has(document.mediaType)) return new Response('Not found', { status: 404 });

  return new Response(new Uint8Array(await storage.get(document.storageKey)), {
    headers: {
      'Content-Type': document.mediaType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}
