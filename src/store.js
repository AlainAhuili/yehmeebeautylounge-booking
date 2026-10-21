// Small JSON-file store for users, sessions, bookings, vouchers and password resets.
// Held in memory and written to disk atomically (temp file + rename) on every change.
// Pass `null` as the file for an in-memory store (tests).
// With a DATABASE_URL, openStore() uses MariaDB instead (src/mariadb-store.js).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const EMPTY = { users: [], sessions: [], bookings: [], vouchers: [], resets: [], serviceImages: {}, gallery: { uploads: [], hidden: [] } };

/** MariaDB when a database URL is given, otherwise the JSON file. */
export async function openStore({ databaseUrl, file }) {
  if (databaseUrl) {
    const { MariaStore } = await import('./mariadb-store.js');
    return MariaStore.open(databaseUrl);
  }
  return new Store(file);
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    if (file) {
      try {
        this.data = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  /** Runs a change and saves once. */
  change(fn) {
    const result = fn(this.data);
    this.save();
    return result;
  }

  // Saving is immediate here; these match the MariaDB store
  async flush() {}
  async close() {}
}
