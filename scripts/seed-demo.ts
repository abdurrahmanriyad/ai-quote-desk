/** Fills the public demo with real pipeline results. Runs once, and costs a few cents. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { catalog, company, rules } from '../src/app-context';
import { connect } from '../src/db/index';
import { extractRequest, requestContent } from '../src/extraction/extract';
import { createTenant, processCase, receiveRequest } from '../src/intake/cases';
import { approveQuote } from '../src/review/review';
import { localStorage } from '../src/storage/index';

const SAMPLES = [
  ['eval-set/eval-040', 'request.txt', 'text/plain'],
  ['eval-set/eval-001', 'request.txt', 'text/plain'],
  ['eval-set/eval-046', 'request.txt', 'text/plain'],
  ['samples/rfq-029', 'request.txt', 'text/plain'],
  ['samples/rfq-001', 'request.txt', 'text/plain'],
] as const;

const db = connect();
const storage = localStorage(process.env.STORAGE_DIR ?? '.data/files');
const client = new Anthropic();
const model = process.env.EXTRACTION_MODEL ?? 'claude-haiku-5-5';

const { rows } = await db.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1 ORDER BY created_at LIMIT 1', [company.name]);
const tenantId = rows[0]?.id ?? (await createTenant(db, company.name));
const pipeline = {
  db,
  storage,
  catalog,
  rules,
  extract: (mediaType: string, bytes: Buffer) => extractRequest(client, { model, content: requestContent(mediaType, bytes) }),
};

for (const [folder, file] of SAMPLES) {
  const bytes = readFileSync(join('data', folder, file));
  const { caseId } = await receiveRequest({ db, storage, enqueue: async () => {} }, { tenantId, filename: file, bytes });
  await processCase(pipeline, { tenantId, caseId });
}

const { rows: last } = await db.query<{ id: string }>(
  `SELECT q.id FROM quote_cases q JOIN case_drafts d ON d.case_id = q.id
   WHERE q.tenant_id = $1 AND q.status = 'needs_review' AND d.price ->> 'totalCents' IS NOT NULL
   ORDER BY q.created_at DESC LIMIT 1`,
  [tenantId],
);
if (last[0]) await approveQuote(db, { tenantId, caseId: last[0].id, reviewer: 'Demo reviewer', acknowledgedIssues: true });

await db.end();
console.log('Demo data ready');
