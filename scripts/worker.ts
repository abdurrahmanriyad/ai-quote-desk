import { connect } from '../src/db/index.js';
import { recoverStuckCases } from '../src/intake/cases.js';
import { connectionFrom, createCaseQueue, startCaseWorker } from '../src/jobs/queue.js';
import { localStorage } from '../src/storage/index.js';

const RECOVERY_INTERVAL_MS = 60_000;
const STUCK_AFTER_MS = 5 * 60_000;

const db = connect();
const storage = localStorage(process.env.STORAGE_DIR ?? '.data/files');
const options = { connection: connectionFrom() };
const { queue, enqueue } = createCaseQueue(options);
const worker = startCaseWorker({ db, storage }, options);

const recovery = setInterval(() => {
  recoverStuckCases({ db, enqueue }, STUCK_AFTER_MS).catch(console.error);
}, RECOVERY_INTERVAL_MS);

console.log('Worker running');

const shutdown = async () => {
  clearInterval(recovery);
  await worker.close();
  await queue.close();
  await db.end();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
