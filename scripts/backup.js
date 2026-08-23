/** `npm run backup` — take an on-demand backup. Safe to run while the server is up. */
const database = require('../src/database');
const backup = require('../src/backup');

const conn = database.open();
const file = backup.backupNow(conn, database.backupDir());
conn.close();
console.log(`Backup written: ${file}`);
