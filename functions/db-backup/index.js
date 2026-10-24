// db-backup: nightly copy of the booking database.
// Trigger: Cloud Scheduler calls it (HTTP POST, signed in with its own service account).
// It reaches MariaDB on the VM over the internal network (Direct VPC egress), reads every
// table in one consistent snapshot as a read-only user, and writes a gzipped SQL file to
//   gs://BACKUP_BUCKET/db/yehmee-<UTC time>.sql.gz
// which `mariadb yehmee < file.sql` restores. The bucket deletes copies after 30 days.

import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import mariadb from 'mariadb';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const ROWS_PER_INSERT = 200;

export const quoteName = (name) => `\`${String(name).replaceAll('`', '``')}\``;

/** A value as an SQL literal that MariaDB reads back unchanged. */
export function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) return value.length ? `X'${value.toString('hex')}'` : "''";
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const escaped = text.replace(/[\\'\0\n\r\x1a]/g, (c) => ({ '\\': '\\\\', "'": "\\'", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' })[c]);
  return `'${escaped}'`;
}

/** The SQL statements of a full dump, one string at a time. Counts tables and rows in `stats`. */
export async function* dumpStatements(conn, stats = { tables: 0, rows: 0 }, now = new Date()) {
  yield `-- YehMee booking database, ${now.toISOString()}\n`;
  yield 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n';
  const tables = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
  for (const row of tables) {
    const table = Object.values(row)[0];
    const [create] = await conn.query(`SHOW CREATE TABLE ${quoteName(table)}`);
    yield `DROP TABLE IF EXISTS ${quoteName(table)};\n${create['Create Table']};\n`;
    const rows = await conn.query(`SELECT * FROM ${quoteName(table)}`);
    const columns = rows.meta?.map((c) => c.name()) ?? Object.keys(rows[0] ?? {});
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const values = rows.slice(i, i + ROWS_PER_INSERT).map((r) => `(${columns.map((c) => sqlValue(r[c])).join(',')})`);
      yield `INSERT INTO ${quoteName(table)} (${columns.map(quoteName).join(',')}) VALUES\n${values.join(',\n')};\n`;
    }
    yield '\n';
    stats.tables += 1;
    stats.rows += rows.length;
  }
  yield 'SET FOREIGN_KEY_CHECKS=1;\n';
}

const stamp = (d) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export function makeBackup({
  env = process.env,
  storage = new Storage(),
  connect = () => mariadb.createConnection({
    host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
    dateStrings: true, connectTimeout: 10_000,
  }),
  clock = () => new Date(),
} = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').send('Method Not Allowed');
    const now = clock();
    const file = `db/${env.DB_NAME}-${stamp(now)}.sql.gz`;
    const stats = { tables: 0, rows: 0 };
    const conn = await connect();
    try {
      // One snapshot for all tables, so bookings and their vouchers match
      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const object = storage.bucket(env.BACKUP_BUCKET).file(file);
      await pipeline(
        Readable.from(dumpStatements(conn, stats, now)),
        createGzip(),
        object.createWriteStream({ resumable: false, contentType: 'application/gzip' }),
      );
      await conn.query('COMMIT');
    } finally {
      await conn.end();
    }
    const summary = { file: `gs://${env.BACKUP_BUCKET}/${file}`, ...stats };
    console.log('Backup written', JSON.stringify(summary));
    return res.status(200).json(summary);
  };
}

functions.http('dbBackup', makeBackup());
