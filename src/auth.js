/** Authentication: bearer-token sessions kept in memory, plus role guards. */
const db = require('./db');

function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Attaches req.user when a valid token is present; rejects otherwise. */
function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  const user = token ? db.getSessionUser(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  req.user = user;
  req.token = token;
  next();
}

/** Use after requireAuth. Blocks users whose role does not match. */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can do this.` });
    }
    next();
  };
}

/**
 * Use after requireAuth for routes several roles share. Named roles only —
 * "any signed-in user" is never the right guard, because the admin is signed
 * in too and must not reach clinical data.
 */
function requireAnyRole(...roles) {
  const label = roles.join('s or ') + 's';
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Only ${label} can do this.` });
    }
    next();
  };
}

/** Doctors and pharmacists — everyone with clinical access. Excludes the admin. */
const requireClinical = requireAnyRole('doctor', 'pharmacist');

// ---------------------------------------------------------------- handlers
function login(req, res) {
  const { username, password } = req.body || {};
  const user = db.findUserByUsername(username);
  if (!user || !db.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (!user.active) {
    return res.status(401).json({ error: 'This account has been deactivated. Ask the administrator.' });
  }
  const token = db.createSession(user.id);
  res.json({ token, user: db.publicUser(user) });
}


function logout(req, res) {
  db.destroySession(req.token);
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ user: db.publicUser(req.user) });
}

module.exports = { requireAuth, requireRole, requireAnyRole, requireClinical, login, logout, me };
