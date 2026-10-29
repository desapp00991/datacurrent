const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await client.connect();
  try { await client.query(fs.readFileSync(path.join(__dirname, '..', 'migrations/001_initial.sql'), 'utf8')); console.log('Database schema is ready.'); }
  finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
