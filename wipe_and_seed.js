const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const pool = new Pool({ user: 'postgres', host: 'localhost', database: 'laams', password: 'password', port: 5432 });

async function wipeAndSeed() {
  try {
    console.log('Wiping database...');
    await pool.query('TRUNCATE users CASCADE');
    await pool.query('TRUNCATE books CASCADE');
    await pool.query('TRUNCATE classes CASCADE');
    await pool.query('TRUNCATE study_materials CASCADE');
    await pool.query('TRUNCATE exams CASCADE');
    await pool.query('TRUNCATE assignments CASCADE');
    await pool.query('TRUNCATE lessons CASCADE');
    
    console.log('Inserting super admin...');
    const hash = await bcrypt.hash('dddddddd', 10);
    
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, first_name, last_name, role)
      VALUES (
        '00000000-0000-0000-0000-000000000003',
        'dhvaj',
        'dhvaj@edu',
        $1,
        'Dhvaj',
        'Admin',
        'admin'
      )
    `, [hash]);

    console.log('Done!');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

wipeAndSeed();
