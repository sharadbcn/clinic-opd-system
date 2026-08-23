/** Sunrise Clinic OPD — local server. Run with `npm start`, then open http://localhost:3000 */
const path = require('path');
const express = require('express');
const db = require('./src/db');
const database = require('./src/database');
const backup = require('./src/backup');
const apiRoutes = require('./src/routes');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

// Unknown API paths get JSON, not the HTML fallback.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

const conn = db.init();
const seeded = db.seedIfEmpty();
const backupFile = backup.dailyBackup(conn, database.backupDir());

app.listen(PORT, () => {
  const demoAccounts = db.isDemo() ? `
  │                                                          │
  │   Demo staff (delete or deactivate in Administration)    │
  │   Doctor      dr.sharma  /  doctor123                    │
  │   Doctor      dr.patel   /  doctor123                    │
  │   Pharmacist  pharma     /  pharma123                    │` : `
  │                                                          │
  │   No clinical staff yet — sign in as admin and add them. │`;

  console.log(`
  ┌──────────────────────────────────────────────────────────┐
  │   Sunrise Clinic OPD  ·  http://localhost:${PORT}           │
  ├──────────────────────────────────────────────────────────┤
  │   Administrator                                          │
  │   ${(db.ADMIN.username + '  /  ' + db.ADMIN.password).padEnd(55)}│${demoAccounts}
  └──────────────────────────────────────────────────────────┘

  Database  ${database.dbPath()}${seeded ? '  (new — demo data loaded)' : ''}
  Backup    ${backupFile || 'already taken today in ' + database.backupDir()}
`);
});
