const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'laams',
  password: 'admin',
  port: 5432,
});

async function run() {
  try {
    const res = await pool.query(
      "SELECT title, full_text, segments FROM lessons WHERE id = $1",
      ["7511241d-1163-4d1c-aa4c-02d761743973"]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      console.log('Title:', row.title);
      console.log('Full Text Length:', row.full_text?.length);
      console.log('Segments Length:', row.segments?.length);
      console.log('Preview:');
      console.log(row.full_text?.substring(0, 1500));
    } else {
      console.log('Lesson not found in lessons table.');
      
      // Let's also check study_materials
      const resMat = await pool.query(
        "SELECT title, body FROM study_materials WHERE id = $1",
        ["7511241d-1163-4d1c-aa4c-02d761743973"]
      );
      if (resMat.rows.length > 0) {
        const row = resMat.rows[0];
        console.log('Study Material Title:', row.title);
        console.log('Body Length:', row.body?.length);
        console.log('Body Preview:');
        console.log(row.body?.substring(0, 1500));
      } else {
        console.log('Lesson not found in study_materials table either.');
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

run();
