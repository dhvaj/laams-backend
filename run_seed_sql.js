require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'laams',
      password: process.env.DB_PASSWORD || 'admin',
      port: parseInt(process.env.DB_PORT || '5432', 10),
    });

async function run() {
  try {
    const sqlPath = path.join(__dirname, '../laams-frontend/database/postgresql/seed.sql');
    let sql = fs.readFileSync(sqlPath, 'utf8');

    // Remove comments
    sql = sql.replace(/--.*$/gm, '');

    console.log('Truncating tables...');
    await pool.query('TRUNCATE users CASCADE');
    // await pool.query('TRUNCATE books CASCADE');
    await pool.query('TRUNCATE classes CASCADE');
    await pool.query('TRUNCATE study_materials CASCADE');
    await pool.query('TRUNCATE exams CASCADE');
    await pool.query('TRUNCATE assignments CASCADE');
    await pool.query('TRUNCATE lessons CASCADE');
    await pool.query('TRUNCATE student_profiles CASCADE');

    console.log('Executing seed.sql...');
    await pool.query(sql);
    console.log('Successfully seeded database with seed.sql!');
  } catch (err) {
    console.error('Error seeding database:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
