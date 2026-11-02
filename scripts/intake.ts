/** Submits a file as the demo company: `npm run intake -- path/to/request.txt` */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { connect } from '../src/db/index.js';
import { createTenant, receiveRequest } from '../src/intake/cases.js';
import { connectionFrom, createCaseQueue } from '../src/jobs/queue.js';
import { localStorage } from '../src/storage/index.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: npm run intake -- <file>');

const db = connect();
const { queue, enqueue } = createCaseQueue({ connection: connectionFrom() });
const storage = localStorage(process.env.STORAGE_DIR ?? '.data/files');

const { rows } = await db.query<{ id: string }>("SELECT id FROM tenants WHERE name = 'Northline Fabrication'");
const tenantId = rows[0]?.id ?? (await createTenant(db, 'Northline Fabrication'));

const result = await receiveRequest(
  { db, storage, enqueue },
  { tenantId, filename: basename(path), bytes: readFileSync(path) },
);
console.log(result);

await queue.close();
await db.end();
