import { connect, migrate } from '../src/db/index.js';

const db = connect();
await migrate(db);
await db.end();
console.log('Migrations applied');
