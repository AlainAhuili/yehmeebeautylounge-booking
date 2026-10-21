// Creates an admin account, or makes an existing account an admin.
//   npm run create-admin -- melissa@example.com "Melissa"
// Stop the server first: it keeps the data in memory and would overwrite this change.
// A new account gets a random password, printed once; change it after logging in
// via "Passwort vergessen?".

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';
import { Store } from '../src/store.js';

const [email, name = 'Admin'] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-admin -- <email> "<name>"');
  process.exit(1);
}

const file = process.env.DATA_FILE || fileURLToPath(new URL('../data/db.json', import.meta.url));
const store = new Store(file);
const address = email.trim().toLowerCase();
const existing = store.data.users.find((u) => u.email === address);

if (existing) {
  store.change(() => { existing.role = 'admin'; });
  console.log(`${address} is now an admin. The password is unchanged.`);
} else {
  const password = randomBytes(12).toString('base64url');
  store.change((d) => d.users.push({
    id: `u_${randomBytes(8).toString('hex')}`,
    name,
    email: address,
    phone: '',
    role: 'admin',
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  }));
  console.log(`Admin account created for ${address}.`);
  console.log(`Password (shown only once): ${password}`);
}
