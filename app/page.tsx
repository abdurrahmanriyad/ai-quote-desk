import Link from 'next/link';
import { uploadRequest } from './actions';
import { context } from '../src/app-context';
import { listCases } from '../src/review/review';
import { money } from '../src/review/quote-pdf';

export const dynamic = 'force-dynamic';

const LABELS = {
  received: 'Queued',
  processing: 'Reading',
  needs_review: 'Needs review',
  approved: 'Approved',
  failed: 'Failed',
};

export default async function Inbox({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const { db, tenantId } = await context();
  const cases = await listCases(db, tenantId);
  const working = cases.some((item) => item.status === 'received' || item.status === 'processing');

  return (
    <>
      {working && <meta httpEquiv="refresh" content="3" />}
      <div className="heading">
        <div>
          <h1>Quote requests</h1>
          <p className="muted">Every draft waits here until a person approves it.</p>
        </div>
        <form action={uploadRequest} className="upload">
          <input type="file" name="file" aria-label="Quote request file" accept=".txt,.eml,.csv,.pdf,.png,.jpg,.jpeg" required />
          <button>Add request</button>
        </form>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}

      {cases.length === 0 ? (
        <p className="empty">No requests yet. Add one from <code>data/samples</code> to begin.</p>
      ) : (
        <table className="inbox">
          <thead>
            <tr>
              <th>Customer</th>
              <th>File</th>
              <th>Status</th>
              <th className="number">Total</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link href={`/cases/${item.id}`}>{item.customer ?? 'Unknown customer'}</Link>
                </td>
                <td className="muted">{item.filename}</td>
                <td>
                  <span className={`status ${item.status}`}>{LABELS[item.status]}</span>
                  {Boolean(item.issues) && <span className="flag">{item.issues} to check</span>}
                </td>
                <td className="number">{item.total_cents ? money(Number(item.total_cents)) : '—'}</td>
                <td className="muted">{item.created_at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
