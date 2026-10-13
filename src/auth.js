// Offline, Linux-style local login: salted scrypt hashes in a 0600 file, no network involved.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MIN_PASSWORD = 8;

module.exports = function createAuth(dir) {
  const file = path.join(dir, 'users.json');
  let db = { users: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

  let current = null;
  let fails = 0;
  let lockedUntil = 0;

  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db, null, 2), { mode: 0o600 });
  };
  const derive = (pw, salt) => new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))));
  const validName = (n) => /^[a-z_][a-z0-9_-]{0,31}$/.test(n);

  async function addUser(name, password, role) {
    name = String(name || '').trim().toLowerCase();
    password = String(password || '');
    if (!validName(name)) throw new Error('Username: lowercase letters, digits, _ or -, max 32 chars.');
    if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
    if (db.users[name]) throw new Error('User already exists.');
    const salt = crypto.randomBytes(16);
    const hash = await derive(password, salt);
    db.users[name] = { salt: salt.toString('hex'), hash: hash.toString('hex'), role, created: Date.now() };
    save();
  }

  return {
    hasUsers: () => Object.keys(db.users).length > 0,
    current: () => current,

    // First-run setup only: the first account becomes admin.
    async createFirst(name, password) {
      if (Object.keys(db.users).length) throw new Error('Setup already done.');
      await addUser(name, password, 'admin');
      current = String(name).trim().toLowerCase();
      return current;
    },

    async login(name, password) {
      const wait = lockedUntil - Date.now();
      if (wait > 0) throw new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`);
      name = String(name || '').trim().toLowerCase();
      const user = db.users[name];
      const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16);
      const got = await derive(String(password || ''), salt);
      const want = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64);
      if (!user || !crypto.timingSafeEqual(got, want)) {
        fails++;
        if (fails >= 3) lockedUntil = Date.now() + Math.min(2 ** (fails - 2), 60) * 1000;
        throw new Error('Login incorrect.');
      }
      fails = 0;
      current = name;
      return name;
    },

    logout() { current = null; },

    async addUser(name, password) {
      if (!current || db.users[current]?.role !== 'admin') throw new Error('Admin only.');
      await addUser(name, password, 'user');
    },

    async changePassword(oldPw, newPw) {
      if (!current) throw new Error('Not logged in.');
      const user = db.users[current];
      const ok = crypto.timingSafeEqual(await derive(String(oldPw), Buffer.from(user.salt, 'hex')), Buffer.from(user.hash, 'hex'));
      if (!ok) throw new Error('Current password incorrect.');
      if (String(newPw).length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
      const salt = crypto.randomBytes(16);
      user.salt = salt.toString('hex');
      user.hash = (await derive(String(newPw), salt)).toString('hex');
      save();
    },
  };
};
