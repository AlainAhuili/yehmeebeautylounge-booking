// Small JSON-file store for users, sessions, bookings, vouchers and password resets.
// Held in memory and written to disk atomically (temp file + rename) on every change.
// Pass `null` as the file for an in-memory store (tests).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = { users: [], sessions: [], bookings: [], vouchers: [], resets: [], serviceImages: {}, gallery: { uploads: [], hidden: [] } };

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
}
