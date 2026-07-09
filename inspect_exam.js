const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'laams',
  password: 'admin',
  port: 5432,
});

async function main() {
  try {
    console.log('--- ALL LESSONS ---');
    const res = await pool.query('SELECT id, title, subject_id FROM lessons');
    console.log(res.rows);

    console.log('\n--- ALL SUBJECTS ---');
    const subRes = await pool.query('SELECT id, name FROM subjects');
    console.log(subRes.rows);

    console.log('\n--- ALL CLASSES ---');
    const clsRes = await pool.query('SELECT id, name, subject_id FROM classes');
    console.log(clsRes.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();
