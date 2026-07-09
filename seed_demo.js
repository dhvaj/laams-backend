const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const pool = new Pool({ user: 'postgres', host: 'localhost', database: 'laams', password: 'password', port: 5432 });

async function seed() {
  try {
    const hash = await bcrypt.hash('password123', 10);
    const teacherId = crypto.randomUUID();
    const studentId = crypto.randomUUID();
    const classId = crypto.randomUUID();

    await pool.query(`DELETE FROM users WHERE username IN ('demo_teacher', 'demo_student')`);

    // 1. Create Teacher
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, first_name, last_name, role)
      VALUES ($1, 'demo_teacher', 'teacher@edu.com', $2, 'Demo', 'Teacher', 'teacher')
    `, [teacherId, hash]);

    // 2. Create Student
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, first_name, last_name, role)
      VALUES ($1, 'demo_student', 'student@edu.com', $2, 'Demo', 'Student', 'student')
    `, [studentId, hash]);

    // 3. Create Class
    await pool.query(`
      INSERT INTO classes (id, name, grade_level, focus, teacher_id)
      VALUES ($1, '10th Class Biology', '10', 'Biology', $2)
    `, [classId, teacherId]);

    // 4. Assign Student to Class
    await pool.query(`
      INSERT INTO student_profiles (user_id, class_id, grade_level, accessibility_profile)
      VALUES ($1, $2, '10', 'typical')
    `, [studentId, classId]);

    console.log('Successfully seeded teacher, student, and class!');
  } catch (err) {
    console.error('Error seeding data:', err);
  } finally {
    await pool.end();
  }
}

seed();
