import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { dumpStatements, makeBackup, quoteName, sqlValue } from './index.js';

test('values become SQL literals that read back unchanged', () => {
  assert.equal(sqlValue(null), 'NULL');
  assert.equal(sqlValue(15), '15');
  assert.equal(sqlValue(1761030000000n), '1761030000000');
  assert.equal(sqlValue('15.00'), "'15.00'");
  assert.equal(sqlValue('2026-10-23 07:00:00.123'), "'2026-10-23 07:00:00.123'");
  assert.equal(sqlValue("O'Brien \\ \n neu"), "'O\\'Brien \\\\ \\n neu'");
  assert.equal(sqlValue("'); DROP TABLE users; --"), "'\\'); DROP TABLE users; --'");
  assert.equal(sqlValue(Buffer.from([0xde, 0xad])), "X'dead'");
  assert.equal(sqlValue(true), '1');
  assert.equal(quoteName('we`ird'), '`we``ird`');
});

/** A MariaDB connection with two tables in memory. */
function fakeConnection() {
  const tables = {
    users: { create: 'CREATE TABLE `users` (`id` varchar(32) NOT NULL, `name` varchar(80) NOT NULL)', rows: [{ id: 'u_1', name: "Ann'a" }, { id: 'u_2', name: 'Ben' }] },
    vouchers: { create: 'CREATE TABLE `vouchers` (`code` varchar(64) NOT NULL)', rows: [] },
  };
  const queries = [];
  return {
    queries,
    ended: false,
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SHOW FULL TABLES')) return Object.keys(tables).map((t) => ({ Tables_in_yehmee: t, Table_type: 'BASE TABLE' }));
      const name = /`(\w+)`/.exec(sql)?.[1];
      if (sql.startsWith('SHOW CREATE TABLE')) return [{ Table: name, 'Create Table': tables[name].create }];
      if (sql.startsWith('SELECT')) return tables[name].rows;
      return [];
    },
    async end() { this.ended = true; },
  };
}

test('the dump recreates every table with its rows', async () => {
  const stats = { tables: 0, rows: 0 };
  let sql = '';
  for await (const part of dumpStatements(fakeConnection(), stats, new Date('2026-10-24T01:00:00Z'))) sql += part;
  assert.match(sql, /SET FOREIGN_KEY_CHECKS=0;/);
  assert.match(sql, /DROP TABLE IF EXISTS `users`;\nCREATE TABLE `users`/);
  assert.match(sql, /INSERT INTO `users` \(`id`,`name`\) VALUES\n\('u_1','Ann\\'a'\),\n\('u_2','Ben'\);/);
  assert.doesNotMatch(sql, /INSERT INTO `vouchers`/, 'an empty table gets no INSERT');
  assert.deepEqual(stats, { tables: 2, rows: 2 });
});

test('the function writes one gzipped file per run, in a read-only snapshot', async () => {
  const conn = fakeConnection();
  const written = {};
  const storage = {
    bucket: (bucket) => ({
      file: (name) => ({
        createWriteStream() {
          const chunks = [];
          const stream = new PassThrough();
          stream.on('data', (c) => chunks.push(c)).on('end', () => { written[`${bucket}/${name}`] = Buffer.concat(chunks); });
          return stream;
        },
      }),
    }),
  };
  const backup = makeBackup({ env: { DB_NAME: 'yehmee', BACKUP_BUCKET: 'backups' }, storage, connect: async () => conn, clock: () => new Date('2026-10-24T01:00:00Z') });
  let status;
  let body;
  const res = { status(c) { status = c; return this; }, set() { return this; }, json(b) { body = b; }, send(b) { body = b; } };

  await backup({ method: 'POST' }, res);
  assert.equal(status, 200);
  assert.deepEqual(body, { file: 'gs://backups/db/yehmee-20261024-0100.sql.gz', tables: 2, rows: 2 });
  assert.match(gunzipSync(written['backups/db/yehmee-20261024-0100.sql.gz']).toString(), /CREATE TABLE `users`/);
  assert.ok(conn.queries.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'));
  assert.ok(conn.ended, 'the connection is closed');

  await backup({ method: 'GET' }, res);
  assert.equal(status, 405);
});
