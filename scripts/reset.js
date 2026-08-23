/**
 * `npm run reset` — delete the database so the next `npm start` re-seeds
 * the demo clinic. Stop the server first. Backups are left untouched.
 */
const fs = require('fs');
const database = require('../src/database');

const file = database.dbPath();
let removed = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const p = file + suffix;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    removed += 1;
  }
}
console.log(removed
  ? `Removed ${file}. Demo data will be re-created on the next start.`
  : `Nothing to remove — ${file} does not exist.`);
