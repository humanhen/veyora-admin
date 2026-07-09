/* Creates or updates a staff login.
   Usage: node scripts/seed-admin.mjs <email> <password> [role] [name]
   role: admin (default) | warehouse | agent | super-agent */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [email, password, role = 'admin', name = 'Veyora'] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('usage: node scripts/seed-admin.mjs <email> <password(8+ chars)> [role] [name]');
  process.exit(1);
}
if (!['admin', 'warehouse', 'agent', 'super-agent'].includes(role)) {
  console.error(`invalid role: ${role}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hash = await bcrypt.hash(password, 10);
const username = email.split('@')[0].toLowerCase();

const { rows } = await pool.query(`
  insert into users (username, first_name, business, email, role, status, password_hash, protected)
  values ($1, $2, 'Veyora HQ', $3, $4, 'active', $5, true)
  on conflict (email) do update set
    password_hash = excluded.password_hash, role = excluded.role,
    status = 'active', protected = true
  returning id, email, role`, [username, name, email.toLowerCase(), role, hash]);

console.log('staff login ready:', rows[0]);
await pool.end();
