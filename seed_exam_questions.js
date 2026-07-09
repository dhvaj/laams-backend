require('dotenv').config();
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'laams',
      password: process.env.DB_PASSWORD || 'admin',
      port: parseInt(process.env.DB_PORT || '5432', 10),
    });

async function seed() {
  console.log('Seeding exam questions for Midterm: History...');
  try {
    const historyExamId = '50000000-0000-0000-0000-000000000002';
    
    // Clear existing questions for this exam to ensure clean re-seeding
    console.log('Cleaning up existing questions...');
    await pool.query('DELETE FROM exam_questions WHERE exam_id = $1', [historyExamId]);

    const questions = [
      {
        id: 'c5b8e9aa-1234-4567-8910-111213141516',
        exam_id: historyExamId,
        position: 1,
        question_type: 'mcq',
        prompt: 'Who was the first President of the United States?',
        options: ['George Washington', 'Thomas Jefferson', 'John Adams', 'Benjamin Franklin'],
        correct_answer: 'George Washington',
        accessibility_notes: {
          dyslexic: 'Dyslexia friendly spacing and layout',
          id: {
            helperImage: 'https://images.unsplash.com/photo-1537989370066-7d8db5df9be0?auto=format&fit=crop&q=80&w=600',
            alt: 'Portrait of George Washington'
          },
          deaf: {
            vocabulary: [
              { word: 'President', definition: 'The elected head of a republican state.' }
            ]
          }
        }
      },
      {
        id: 'c5b8e9aa-1234-4567-8910-111213141517',
        exam_id: historyExamId,
        position: 2,
        question_type: 'mcq',
        prompt: 'In which year did World War II end?',
        options: ['1918', '1945', '1939', '1950'],
        correct_answer: '1945',
        accessibility_notes: {
          blind: 'Provide text description of the global treaty events in 1945.',
          deaf: {
            vocabulary: [
              { word: 'World War II', definition: 'A global war that lasted from 1939 to 1945.' }
            ]
          }
        }
      },
      {
        id: 'c5b8e9aa-1234-4567-8910-111213141518',
        exam_id: historyExamId,
        position: 3,
        question_type: 'short',
        prompt: 'Explain the primary cause of the American Civil War.',
        options: null,
        correct_answer: 'The primary cause of the American Civil War was the long-standing controversy over the enslavement of black people.',
        accessibility_notes: {
          adhd: 'Keep response field clear and clean',
          deaf: {
            vocabulary: [
              { word: 'controversy', definition: 'A state of prolonged public disagreement or debate.' },
              { word: 'enslavement', definition: 'The state of being owned and forced to work by another person.' }
            ]
          }
        }
      },
      {
        id: 'c5b8e9aa-1234-4567-8910-111213141519',
        exam_id: historyExamId,
        position: 4,
        question_type: 'descriptive',
        prompt: 'Describe the social and economic impact of the Industrial Revolution on workers in Europe during the 19th century.',
        options: null,
        correct_answer: 'The Industrial Revolution led to rapid urbanization, crowded housing, poor working conditions, and the growth of the labor movement.',
        accessibility_notes: {
          deaf: {
            vocabulary: [
              { word: 'Industrialization', definition: 'The development of industries in a country or region on a wide scale.' },
              { word: 'Urbanization', definition: 'The process of making an area more urban (city-like).' }
            ]
          },
          id: {
            helperImage: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&q=80&w=600',
            alt: 'Industrial Revolution machinery and factory floor'
          }
        }
      }
    ];

    for (const q of questions) {
      await pool.query(
        `INSERT INTO exam_questions (id, exam_id, position, question_type, prompt, options, correct_answer, accessibility_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [q.id, q.exam_id, q.position, q.question_type, q.prompt, q.options ? JSON.stringify(q.options) : null, q.correct_answer, JSON.stringify(q.accessibility_notes)]
      );
      console.log(`Inserted question ${q.position}: "${q.prompt}"`);
    }
    console.log('Seeding completed successfully!');
  } catch (err) {
    console.error('Error seeding questions:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
