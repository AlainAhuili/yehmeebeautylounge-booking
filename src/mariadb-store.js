// MariaDB store: the same interface as the JSON store (store.data + store.change).
// Everything is loaded into memory at startup, so the app reads without waiting.
// After each change, only the rows that differ are written, in one transaction,
// in the order the changes happened. One server process per database.

import mariadb from 'mariadb';
import { readFileSync } from 'node:fs';
import { EMPTY } from './store.js';

// ISO time (UTC) <-> DATETIME(3); null columns are left out, as in the JSON store
const toSql = (iso) => (iso ? iso.replace('T', ' ').replace('Z', '') : null);
const fromSql = (value) => (value ? `${value.replace(' ', 'T')}Z` : null);
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

// Each table: its key column, how to turn store.data into rows, and back.
// Listed parents first: rows are written in this order and deleted in reverse.
const TABLES = [
  {
    name: 'users', key: 'id', order: 'created_at',
    rows: (d) => d.users.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, password_hash: u.passwordHash,
      role: u.role ?? null, created_at: toSql(u.createdAt),
    })),
    load: (d, rows) => {
      d.users = rows.map((r) => compact({
        id: r.id, name: r.name, email: r.email, phone: r.phone, passwordHash: r.password_hash,
        role: r.role, createdAt: fromSql(r.created_at),
      }));
    },
  },
  {
    name: 'bookings', key: 'id', order: 'created_at',
    rows: (d) => d.bookings.map((b) => ({
      id: b.id, user_id: b.userId, service_id: b.serviceId, service_name: b.serviceName,
      duration_min: b.durationMin, price_eur: b.priceEur, date: b.date, time: b.time,
      start_min: b.start, end_min: b.end, end_time: b.endTime, note: b.note ?? '',
      payment_method: b.payment.method, voucher_code: b.payment.voucherCode ?? null, deposit_eur: b.payment.depositEur,
      status: b.status, created_at: toSql(b.createdAt), cancelled_at: toSql(b.cancelledAt),
      deposit_refunded: b.depositRefunded ?? null,
    })),
    load: (d, rows) => {
      d.bookings = rows.map((r) => compact({
        id: r.id, userId: r.user_id, serviceId: r.service_id, serviceName: r.service_name,
        durationMin: r.duration_min, priceEur: r.price_eur, date: r.date, time: r.time,
        start: r.start_min, end: r.end_min, endTime: r.end_time, note: r.note,
        payment: compact({ method: r.payment_method, voucherCode: r.voucher_code, depositEur: r.deposit_eur }),
        status: r.status, createdAt: fromSql(r.created_at), cancelledAt: fromSql(r.cancelled_at),
        depositRefunded: r.deposit_refunded === null ? null : Boolean(r.deposit_refunded),
      }));
    },
  },
  {
    name: 'vouchers', key: 'code',
    rows: (d) => d.vouchers.map((v) => ({ code: v.code, note: v.note ?? null, used_by: v.usedBy ?? null })),
    load: (d, rows) => { d.vouchers = rows.map((r) => compact({ code: r.code, note: r.note, usedBy: r.used_by })); },
  },
  {
    name: 'sessions', key: 'token_hash',
    rows: (d) => d.sessions.map((s) => ({ token_hash: s.tokenHash, user_id: s.userId, expires_at: s.expiresAt })),
    load: (d, rows) => { d.sessions = rows.map((r) => ({ tokenHash: r.token_hash, userId: r.user_id, expiresAt: r.expires_at })); },
  },
  {
    name: 'resets', key: 'token_hash',
    rows: (d) => d.resets.map((s) => ({ token_hash: s.tokenHash, user_id: s.userId, expires_at: s.expiresAt })),
    load: (d, rows) => { d.resets = rows.map((r) => ({ tokenHash: r.token_hash, userId: r.user_id, expiresAt: r.expires_at })); },
  },
  {
    name: 'service_images', key: 'service_id',
    rows: (d) => Object.entries(d.serviceImages).map(([id, img]) => ({
      service_id: id, file: img.file, uploaded_at: toSql(img.uploadedAt), uploaded_by: img.uploadedBy,
    })),
    load: (d, rows) => {
      d.serviceImages = Object.fromEntries(rows.map((r) => [r.service_id, { file: r.file, uploadedAt: fromSql(r.uploaded_at), uploadedBy: r.uploaded_by }]));
    },
  },
  {
    name: 'gallery_uploads', key: 'id', order: 'seq',
    rows: (d) => d.gallery.uploads.map((u) => ({
      id: u.id, section: u.section, file: u.file, uploaded_at: toSql(u.uploadedAt), uploaded_by: u.uploadedBy,
    })),
    load: (d, rows) => {
      d.gallery.uploads = rows.map((r) => ({ id: r.id, section: r.section, file: r.file, uploadedAt: fromSql(r.uploaded_at), uploadedBy: r.uploaded_by }));
    },
  },
  {
    name: 'gallery_hidden', key: 'photo_id',
    rows: (d) => d.gallery.hidden.map((id) => ({ photo_id: id })),
    load: (d, rows) => { d.gallery.hidden = rows.map((r) => r.photo_id); },
  },
];

const SCHEMA = new URL('../db/schema.sql', import.meta.url);

/** mariadb://user:password@host:port/database */
function connectionFrom(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  };
}

export class MariaStore {
  /** Connects, creates missing tables and loads all data. */
  static async open(url) {
    const pool = mariadb.createPool({
      ...connectionFrom(url),
      connectionLimit: 3,
      dateStrings: true, // DATE and DATETIME as text, never shifted by the server's time zone
      bigIntAsNumber: true,
      decimalAsNumber: true,
    });
    const store = new MariaStore(pool);
    try {
      await store.migrate();
      await store.load();
    } catch (err) {
      await pool.end();
      throw err;
    }
    return store;
  }

  constructor(pool) {
    this.pool = pool;
    this.data = structuredClone(EMPTY);
    this.saved = new Map(); // table -> (key -> row as JSON), as last written
    this.dirty = false;
    this.queue = Promise.resolve();
  }

  async migrate() {
    const statements = readFileSync(SCHEMA, 'utf8').replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const sql of statements) await this.pool.query(sql);
  }

  async load() {
    for (const t of TABLES) {
      const rows = await this.pool.query(`SELECT * FROM ${t.name}${t.order ? ` ORDER BY ${t.order}` : ''}`);
      t.load(this.data, rows);
    }
    this.saved = this.snapshot();
  }

  /** True when the database holds no data yet. */
  isEmpty() {
    return [...this.saved.values()].every((rows) => rows.size === 0);
  }

  snapshot() {
    return new Map(TABLES.map((t) => [t.name, new Map(t.rows(this.data).map((row) => [row[t.key], JSON.stringify(row)]))]));
  }

  /** Runs a change and saves once (in the background; see flush). */
  change(fn) {
    const result = fn(this.data);
    this.save();
    return result;
  }

  save() {
    this.dirty = true;
    this.flush().catch((err) => console.error('[db] Could not save to MariaDB; trying again with the next change.', err));
  }

  /** Resolves once every change so far is in the database. */
  flush() {
    this.queue = this.queue.catch(() => {}).then(() => this.write());
    return this.queue;
  }

  async write() {
    if (!this.dirty) return;
    this.dirty = false;
    const now = this.snapshot();
    const deletes = [];
    const upserts = [];
    for (const t of TABLES) {
      const before = this.saved.get(t.name);
      const after = now.get(t.name);
      for (const key of before.keys()) if (!after.has(key)) deletes.push([t, key]);
      for (const [key, json] of after) if (before.get(key) !== json) upserts.push([t, JSON.parse(json)]);
    }
    if (!deletes.length && !upserts.length) return;

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [t, key] of deletes.reverse()) await conn.query(`DELETE FROM ${t.name} WHERE ${t.key} = ?`, [key]);
      for (const [t, row] of upserts) {
        const cols = Object.keys(row);
        await conn.query(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
           ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
          Object.values(row),
        );
      }
      await conn.commit();
      this.saved = now;
    } catch (err) {
      await conn.rollback().catch(() => {});
      this.dirty = true; // the next save tries again with everything still missing
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Writes what is left and disconnects. */
  async close() {
    try {
      await this.flush();
    } finally {
      await this.pool.end();
    }
  }
}
