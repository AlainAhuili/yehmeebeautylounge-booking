// Copies data/db.json into an empty MariaDB database (DATABASE_URL), once.
//   npm run db:import
// The JSON file is only read, never changed. Stop the server first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MariaStore } from '../src/mariadb-store.js';
import { EMPTY } from '../src/store.js';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch (err) { if (err.code !== 'ENOENT') throw err; }
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL first (see .env.example).');
  process.exit(1);
}

const file = process.env.DATA_FILE || fileURLToPath(new URL('../data/db.json', import.meta.url));
const json = JSON.parse(readFileSync(file, 'utf8'));
const store = await MariaStore.open(process.env.DATABASE_URL);

if (!store.isEmpty()) {
  await store.close();
  console.error('The database already has data; nothing was imported.');
  process.exit(1);
}

store.data = { ...structuredClone(EMPTY), ...json };
store.save();
await store.close();
const d = store.data;
console.log(`Imported ${file}: ${d.users.length} users, ${d.bookings.length} bookings, ${d.vouchers.length} vouchers, ${d.sessions.length} sessions.`);
