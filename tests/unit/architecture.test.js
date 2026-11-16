'use strict';
/**
 * Architecture rules, checked on the source so they cannot erode quietly:
 *  - each money table has one owner module that may write it;
 *  - routes are the HTTP edge: they do not open the database or the stock ledger tables themselves;
 *  - the domain modules (server/lib) do not depend on routes or on Fastify.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'server');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : files(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}
const sources = files(root).map((f) => ({ file: path.relative(root, f), text: fs.readFileSync(f, 'utf8') }));
// dev.js builds demo data on purpose (inside db.maintenance); it is not part of the running app
const app = sources.filter((s) => s.file !== 'dev.js');

const OWNERS = {
  stock_moves: ['lib/stock.js'],
  audit_log: ['lib/audit.js'],
  price_history: ['lib/sync.js'],
  statements: ['lib/statements.js'],
  statement_items: ['lib/statements.js'],
  order_lines: ['lib/orders.js'],
  returns: ['lib/returns.js'],
  tasks: ['lib/tasks.js'],
  idempotency_keys: ['lib/idempotency.js'],
  dk_jobs: ['lib/digikala.js'],
  dk_connection: ['lib/digikala.js']
};

test('each money table is written by its owner module only', () => {
  const offenders = [];
  for (const [table, owners] of Object.entries(OWNERS)) {
    const write = new RegExp(`(INSERT\\s+(OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i');
    for (const s of app) if (write.test(s.text) && !owners.includes(s.file)) offenders.push(`${s.file} writes ${table}`);
  }
  assert.deepEqual(offenders, []);
});

test('routes stay at the HTTP edge; the domain does not know about HTTP routes', () => {
  const offenders = [];
  for (const s of app) {
    if (s.file.startsWith('routes/') && /require\(['"]\.\.\/db['"]\)/.test(s.text)) offenders.push(`${s.file} opens the database`);
    if (s.file.startsWith('lib/') && /require\(['"](\.\.\/routes\/|fastify)/.test(s.text)) offenders.push(`${s.file} depends on routes/fastify`);
  }
  assert.deepEqual(offenders, []);
});

test('a transaction never spans an await (db.tx bodies are synchronous)', () => {
  const offenders = [];
  for (const s of app) {
    const re = /db\.tx\(\s*async\b/g;
    if (re.test(s.text)) offenders.push(s.file);
  }
  assert.deepEqual(offenders, []);
});
