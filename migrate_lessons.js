const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'laams',
  password: 'admin',
  port: 5432,
});

async function migrateAndSeed() {
  console.log('Connecting to PostgreSQL to perform migration and seeding...');

  try {
    // 1. Alter table lessons to add content columns
    console.log('Adding content columns to lessons table if they do not exist...');
    await pool.query(`
      ALTER TABLE lessons 
      ADD COLUMN IF NOT EXISTS full_text TEXT,
      ADD COLUMN IF NOT EXISTS media JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS vocabulary JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS segments JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
    `);
    console.log('Table lessons altered successfully.');

    // 2. Load MongoDB seed json
    const mongoSeedPath = path.join(__dirname, '..', 'laams-frontend', 'database', 'mongodb', 'lesson-content.seed.json');
    if (!fs.existsSync(mongoSeedPath)) {
      throw new Error(`Seed JSON not found at ${mongoSeedPath}`);
    }
    const seedData = JSON.parse(fs.readFileSync(mongoSeedPath, 'utf8'));
    console.log(`Loaded ${seedData.length} lessons from MongoDB seed file.`);

    // 3. Insert/update subjects and lessons
    for (const item of seedData) {
      console.log(`Processing lesson: ${item.title} (${item.lessonSlug})...`);

      // Find or insert subject
      const subjectName = item.subject || 'Science';
      let subjectId = null;

      const subjectRes = await pool.query('SELECT id FROM subjects WHERE name = $1', [subjectName]);
      if (subjectRes.rows.length > 0) {
        subjectId = subjectRes.rows[0].id;
      } else {
        console.log(`Subject "${subjectName}" not found. Creating it...`);
        const insertSubRes = await pool.query(
          'INSERT INTO subjects (name, grade_band, description) VALUES ($1, $2, $3) RETURNING id',
          [subjectName, '6-10', `${subjectName} curriculum`]
        );
        subjectId = insertSubRes.rows[0].id;
      }

      // Map contents
      const fullText = item.source ? item.source.text : '';
      const media = item.source && item.source.media ? item.source.media : [];
      const vocabulary = item.vocabulary || [];
      
      // Ensure segments have the level property for the frontend
      const segments = (item.segments || []).map(seg => ({
        id: seg.id,
        heading: seg.heading || '',
        level: seg.level || 2,
        sourceText: seg.sourceText || ''
      }));

      // If the lesson is Solar System, we can enrich it with the additional images from lessons.ts
      if (item.lessonSlug === 'solar-system') {
        // Let's add the other images and vocabulary from static frontend data if available
        media.push(
          {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1532669460596-f947fb7fa069?auto=format&fit=crop&q=80&w=600',
            alt: 'The Sun, a bright burning star.'
          },
          {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1614730321146-b6fa6a46bcb4?auto=format&fit=crop&q=80&w=600',
            alt: 'Planet Earth seen from space.'
          }
        );

        vocabulary.push(
          { word: 'orbit', definition: 'To move around another object in space.' },
          { word: 'molecular cloud', definition: 'A huge cloud of gas and dust in space where stars are born.' },
          { word: 'terrestrial', definition: 'Rocky, Earth-like planets with solid surfaces.' },
          { word: 'volatile', definition: 'A substance, such as water or methane, that changes state more easily than rock or metal.' }
        );
      }

      // Upsert the lesson
      const createdBy = '00000000-0000-0000-0000-000000000002'; // default teacher id
      
      const upsertQuery = `
        INSERT INTO lessons (
          subject_id, title, lesson_slug, grade_level, mongodb_content_id, 
          created_by, full_text, media, vocabulary, segments, language
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (lesson_slug) 
        DO UPDATE SET
          subject_id = EXCLUDED.subject_id,
          title = EXCLUDED.title,
          grade_level = EXCLUDED.grade_level,
          mongodb_content_id = EXCLUDED.mongodb_content_id,
          full_text = EXCLUDED.full_text,
          media = EXCLUDED.media,
          vocabulary = EXCLUDED.vocabulary,
          segments = EXCLUDED.segments,
          language = EXCLUDED.language,
          updated_at = NOW()
        RETURNING id;
      `;

      const values = [
        subjectId,
        item.title,
        item.lessonSlug,
        item.gradeLevel || '8',
        item._id,
        createdBy,
        fullText,
        JSON.stringify(media),
        JSON.stringify(vocabulary),
        JSON.stringify(segments),
        item.language || 'en'
      ];

      const upsertRes = await pool.query(upsertQuery, values);
      console.log(`Saved lesson "${item.title}" with ID ${upsertRes.rows[0].id}`);
    }

    console.log('Migration and seeding completed successfully!');
  } catch (err) {
    console.error('Error during migration and seeding:', err.message);
  } finally {
    await pool.end();
  }
}

migrateAndSeed();
