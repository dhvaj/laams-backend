const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'laams',
  password: 'admin',
  port: 5432,
});

async function check() {
  try {
    const res = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name IN ('assignments', 'study_materials')
      ORDER BY table_name, column_name
    `);
    res.rows.forEach(r => {
      console.log(`${r.table_name}: ${r.column_name} (${r.data_type})`);
    });
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

check();
