require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mammoth = require('mammoth');
const TurndownService = require('turndown');

const JWT_SECRET = process.env.JWT_SECRET || 'laams_super_secret_key_for_beta_testing';
const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:5000';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- File Upload Setup ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });
app.use('/uploads', express.static(uploadDir));

// Generic file upload helper
app.post('/files', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ fileUrl, originalName: req.file.originalname, size: req.file.size });
});


// --- Database Configuration ---
const pool = process.env.DATABASE_URL
  ? new Pool({ 
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
        ? false 
        : { rejectUnauthorized: false }
    })
  : new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'laams',
      password: process.env.DB_PASSWORD || 'admin',
      port: parseInt(process.env.DB_PORT || '5432', 10),
    });

// --- ID Mapping Helpers ---
const ID_MAP = {
  "1": "00000000-0000-0000-0000-000000000001",
  "2": "00000000-0000-0000-0000-000000000002",
  "3": "00000000-0000-0000-0000-000000000003",
  "4": "00000000-0000-0000-0000-000000000004",
  "5": "00000000-0000-0000-0000-000000000005",
  "6": "00000000-0000-0000-0000-000000000006",
  "7": "00000000-0000-0000-0000-000000000007",
  "class-1": "20000000-0000-0000-0000-000000000001",
  "class-2": "20000000-0000-0000-0000-000000000002",
  "subj-1": "10000000-0000-0000-0000-000000000001",
  "subj-2": "10000000-0000-0000-0000-000000000002",
  "subj-3": "10000000-0000-0000-0000-000000000003",
  "assign-1": "40000000-0000-0000-0000-000000000001",
  "assign-2": "40000000-0000-0000-0000-000000000002",
  "exam-1": "50000000-0000-0000-0000-000000000002",
  "exam-2": "50000000-0000-0000-0000-000000000001"
};

const REV_MAP = {};
for (const [k, v] of Object.entries(ID_MAP)) {
  REV_MAP[v] = k;
}

function toUUID(id, prefix) {
  if (!id) return id;
  if (prefix && ID_MAP[prefix + '-' + id]) return ID_MAP[prefix + '-' + id];
  if (ID_MAP[id]) return ID_MAP[id];
  if (ID_MAP["class-" + id]) return ID_MAP["class-" + id];
  if (ID_MAP["subj-" + id]) return ID_MAP["subj-" + id];
  if (ID_MAP["assign-" + id]) return ID_MAP["assign-" + id];
  if (ID_MAP["exam-" + id]) return ID_MAP["exam-" + id];
  return id;
}

function toShortID(uuid) {
  if (!uuid) return uuid;
  if (REV_MAP[uuid]) {
    return REV_MAP[uuid].replace(/^(class-|subj-|assign-|exam-)/, '');
  }
  return uuid;
}

// User Mapper
function mapUser(row) {
  return {
    id: toShortID(row.id),
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    profileId: row.profile_id,
    gradeLevel: row.grade_level,
    classId: toShortID(row.class_id),
    preferredLanguage: row.preferred_language || 'en',
    supportNeeds: row.support_needs || [],
    linkedStudentIds: (row.linked_student_ids || []).map(toShortID)
  };
}

async function translateNode(text, targetLang) {
  if (!targetLang || targetLang === 'en' || !text || !text.trim()) return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data[0].map(x => x[0]).join('');
  } catch (err) {
    console.error('Node translation fallback failed:', err.message);
    return text;
  }
}

async function fallbackAdaptation(lesson, profile, lang) {
  const fullText = lesson.fullText || (lesson.segments || []).map(s => s.sourceText || '').join('\n');
  const paragraphs = fullText.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  const blocks = [];
  let blockIdx = 1;

  for (const p of paragraphs) {
    // Clean metadata-like lines
    if (/^\d+$/.test(p) || p.toLowerCase() === 'unknown' || /^[#\s\d*]+$/.test(p)) {
      continue;
    }

    const translatedP = await translateNode(p, lang);
    const sentences = translatedP.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);

    if (profile === 'dyslexic') {
      blocks.push({
        id: `dyslexic-block-${blockIdx++}`,
        type: 'bullets',
        heading: await translateNode('Key Facts', lang),
        items: sentences
      });
    } else if (profile === 'adhd-autism') {
      let stepNum = 1;
      for (const s of sentences) {
        blocks.push({
          id: `step-${blockIdx++}`,
          type: 'step',
          heading: `${await translateNode('Step', lang)} ${stepNum++}`,
          text: s
        });
      }
    } else if (profile === 'intellectual-disability') {
      let factNum = 1;
      for (const s of sentences) {
        blocks.push({
          id: `id-block-${blockIdx++}`,
          type: 'media',
          heading: `${await translateNode('Fact', lang)} ${factNum++}`,
          text: s,
          media: null
        });
      }
    } else if (profile === 'deaf') {
      blocks.push({
        id: `deaf-bullets-${blockIdx++}`,
        type: 'bullets',
        heading: await translateNode('Key Ideas', lang),
        items: sentences
      });
    } else if (profile === 'blind') {
      blocks.push({
        id: `blind-heading-${blockIdx++}`,
        type: 'heading',
        text: await translateNode('Lesson Section', lang)
      });
      blocks.push({
        id: `blind-text-${blockIdx++}`,
        type: 'text',
        text: translatedP
      });
    } else if (profile === 'low-vision') {
      blocks.push({
        id: `lv-heading-${blockIdx++}`,
        type: 'heading',
        text: await translateNode('Overview', lang)
      });
      blocks.push({
        id: `lv-text-${blockIdx++}`,
        type: 'text',
        text: translatedP
      });
    } else {
      // typical
      blocks.push({
        id: `typical-text-${blockIdx++}`,
        type: 'text',
        text: translatedP
      });
    }
  }

  // Extract vocabulary if missing
  let vocab = lesson.vocabulary || [];
  if (vocab.length === 0) {
    const words = [...new Set(fullText.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/))]
      .filter(w => w.length > 5 && !['about', 'before', 'people', 'would', 'could', 'should', 'their', 'there'].includes(w))
      .slice(0, 3);
    for (const w of words) {
      const transW = await translateNode(w, lang);
      vocab.push({
        word: transW,
        definition: await translateNode(`Key term related to the topic of ${w}.`, lang)
      });
    }
  }

  return {
    profile,
    blocks,
    vocabulary: vocab,
    fallbackUsed: true,
    trace: {
      sourceLessonId: lesson.id,
      outputBlocks: blocks.length,
      operations: [
        "Segmented content programmatically",
        "Generated heuristics-based fallback adaptations in Gateway",
        "Extracted vocabulary programmatically"
      ]
    }
  };
}

async function sendSystemNotification(userId, channel, title, body, entityType, entityId) {
  try {
    const parsedUserId = toUUID(userId);
    const parsedEntityId = entityId ? toUUID(entityId) : null;
    
    const sql = `
      INSERT INTO notifications (user_id, channel, title, body, related_entity_type, related_entity_id, sent_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `;
    await pool.query(sql, [parsedUserId, channel, title, body, entityType, parsedEntityId]);

    if (channel === 'whatsapp') {
      console.log('\n' + '='.repeat(50));
      console.log(' MOCK TWILIO WHATSAPP OUTBOX ALERT');
      console.log('='.repeat(50));
      console.log(`TO (User UUID): ${parsedUserId}`);
      console.log(`MESSAGE BODY:\n"${body}"`);
      console.log('='.repeat(50) + '\n');
    } else if (channel === 'email') {
      console.log('\n' + '='.repeat(50));
      console.log(' MOCK NODEMAILER SMTP OUTBOX ALERT');
      console.log('='.repeat(50));
      console.log(`SUBJECT: ${title}`);
      console.log(`MESSAGE BODY:\n"${body}"`);
      console.log('='.repeat(50) + '\n');
    }
  } catch (err) {
    console.error('Failed to register system notification:', err.message);
  }
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.status(401).json({ error: 'Unauthorized' });

  if (token.startsWith('mock-jwt-token-for-')) {
    const shortId = token.replace('mock-jwt-token-for-', '');
    const id = toUUID(shortId);
    let role = 'student';
    if (shortId === '2') role = 'teacher';
    else if (shortId === '3') role = 'admin';
    else if (shortId === '4') role = 'parent';
    req.user = { id, role };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user ? { ...user, id: user.id ? toUUID(user.id) : undefined } : null;
    next();
  });
};

// --- Endpoints ---


// Check Status
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    postgres: 'connected',
    lessonsDatabase: 'postgresql',
    timestamp: new Date().toISOString()
  });
});

// Users
app.get('/users', authenticateToken, async (req, res) => {
  try {
    let sql = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role,
             sp.accessibility_profile as profile_id, sp.grade_level,
             (SELECT class_id FROM class_students WHERE student_id = u.id LIMIT 1) as class_id,
             sp.preferred_language,
             (SELECT COALESCE(json_agg(support_need), '[]'::json) FROM student_accessibility_needs WHERE student_id = u.id AND is_active = true) as support_needs,
             (SELECT COALESCE(json_agg(student_id), '[]'::json) FROM parent_student_links WHERE parent_id = u.id) as linked_student_ids
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
    `;
    let conditions = [];
    let params = [];

    if (req.query.role) {
      conditions.push(`u.role = $${params.length + 1}`);
      params.push(req.query.role);
    }
    if (req.query.classId) {
      conditions.push(`EXISTS (SELECT 1 FROM class_students WHERE student_id = u.id AND class_id = $${params.length + 1})`);
      params.push(toUUID(req.query.classId, 'class'));
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(mapUser));
  } catch (err) {
    console.error('Error fetching users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/users/:id', authenticateToken, async (req, res) => {
  try {
    const userId = toUUID(req.params.id);
    const sql = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role,
             sp.accessibility_profile as profile_id, sp.grade_level,
             (SELECT class_id FROM class_students WHERE student_id = u.id LIMIT 1) as class_id,
             sp.preferred_language,
             (SELECT COALESCE(json_agg(support_need), '[]'::json) FROM student_accessibility_needs WHERE student_id = u.id AND is_active = true) as support_needs,
             (SELECT COALESCE(json_agg(student_id), '[]'::json) FROM parent_student_links WHERE parent_id = u.id) as linked_student_ids
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      WHERE u.id = $1
    `;
    const { rows } = await pool.query(sql, [userId]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(mapUser(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/users', async (req, res) => {
  try {
    const { 
      username, email, firstName, lastName, role, password, mobile, 
      schoolName, udiseCode, apparNumber, emergencyContact, address,
      gradeLevel, profileId, parentName, parentMobile, parentEmail, parentPassword,
      subjectsTaught, specialization, organization, cwsnExperience, 
      workedDisabilities, hasDisability, disabilityType 
    } = req.body;
    
    const userId = req.body.id ? toUUID(req.body.id) : require('crypto').randomUUID();
    
    const salt = await bcrypt.genSalt(10);
    const passwordHash = password 
      ? await bcrypt.hash(password, salt) 
      : '';

    // Insert into users
    let userSql = `
      INSERT INTO users (id, username, email, password_hash, first_name, last_name, role, mobile, school_name, udise_code, appar_number, emergency_contact, address)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;
    const userParams = [
      userId,
      username || (email ? email.split('@')[0] : 'user') + '_' + Math.floor(1000 + Math.random() * 9000),
      email || `${mobile}@laams.edu`,
      passwordHash,
      firstName,
      lastName,
      role,
      mobile || null,
      schoolName || null,
      udiseCode || null,
      apparNumber || null,
      emergencyContact || null,
      address || null
    ];
    const { rows: userRows } = await pool.query(userSql, userParams);
    const user = userRows[0];

    // If student, insert profile and enroll in default classes
    if (role === 'student') {
      const profileSql = `
        INSERT INTO student_profiles (user_id, grade_level, accessibility_profile, preferred_language, parent_name, parent_mobile, parent_email)
        VALUES ($1, $2, $3, 'en', $4, $5, $6)
      `;
      await pool.query(profileSql, [
        user.id, 
        gradeLevel || '8', 
        profileId || 'typical', 
        parentName || null, 
        parentMobile || null, 
        parentEmail || null
      ]);

      // Auto-create and link parent account if credentials provided
      if (parentMobile && parentName) {
        try {
          const parentId = require('crypto').randomUUID();
          const parentEmailVal = parentEmail || `${parentMobile}@laams.edu`;
          const parentUsername = `parent_${parentMobile}`;
          const parentSalt = await bcrypt.genSalt(10);
          const parentPassHash = parentPassword 
            ? await bcrypt.hash(parentPassword, parentSalt) 
            : await bcrypt.hash('Welcome@123', parentSalt);
            
          // Check if parent already exists
          const { rows: existingParent } = await pool.query('SELECT id FROM users WHERE email = $1 OR username = $2', [parentEmailVal, parentUsername]);
          let finalParentId = parentId;
          if (existingParent.length > 0) {
            finalParentId = existingParent[0].id;
          } else {
            await pool.query(`
              INSERT INTO users (id, username, email, password_hash, first_name, last_name, role, mobile)
              VALUES ($1, $2, $3, $4, $5, $6, 'parent', $7)
            `, [
              parentId,
              parentUsername,
              parentEmailVal,
              parentPassHash,
              parentName.split(' ')[0] || 'Parent',
              parentName.split(' ').slice(1).join(' ') || 'Guardian',
              parentMobile
            ]);
          }
          
          // Link student to parent
          await pool.query(`
            INSERT INTO parent_student_links (parent_id, student_id, relationship)
            VALUES ($1, $2, 'Parent')
            ON CONFLICT DO NOTHING
          `, [finalParentId, user.id]);
        } catch (err) {
          console.warn('Failed to auto-create and link parent account:', err.message);
        }
      }

      // Auto-enroll student in default classes for beta testing
      try {
        await pool.query(
          `INSERT INTO class_students (class_id, student_id)
           VALUES ('20000000-0000-0000-0000-000000000001', $1),
                  ('20000000-0000-0000-0000-000000000002', $1)
           ON CONFLICT DO NOTHING`,
          [user.id]
        );
      } catch (err) {
        console.warn('Failed to auto-enroll new student in default classes:', err.message);
      }
    }

    // If teacher, insert profile
    if (role === 'teacher') {
      const teacherSql = `
        INSERT INTO teacher_profiles (user_id, subjects_taught, specialization, cwsn_experience, worked_disabilities, has_disability, disability_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      await pool.query(teacherSql, [
        user.id,
        subjectsTaught || [],
        specialization || null,
        cwsnExperience === true || cwsnExperience === 'true',
        workedDisabilities || [],
        hasDisability === true || hasDisability === 'true',
        disabilityType || null
      ]);
    }

    res.status(201).json(mapUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Fetch user by email
    const sql = `
      SELECT u.id, u.username, u.email, u.password_hash, u.first_name, u.last_name, u.role,
             sp.accessibility_profile as profile_id, sp.grade_level,
             (SELECT class_id FROM class_students WHERE student_id = u.id LIMIT 1) as class_id,
             sp.preferred_language,
             (SELECT COALESCE(json_agg(support_need), '[]'::json) FROM student_accessibility_needs WHERE student_id = u.id AND is_active = true) as support_needs,
             (SELECT COALESCE(json_agg(student_id), '[]'::json) FROM parent_student_links WHERE parent_id = u.id) as linked_student_ids
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      WHERE u.email = $1
    `;
    const { rows } = await pool.query(sql, [email]);
    
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const userRow = rows[0];

    // Onboarding password setup check for admin registered users
    if (!userRow.password_hash || userRow.password_hash === '' || userRow.password_hash === 'UNSET') {
      return res.json({ requirePasswordSetup: true, userId: toShortID(userRow.id), email: userRow.email });
    }
    
    // Check password
    const isMatch = await bcrypt.compare(password || '', userRow.password_hash || '');
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Generate JWT
    const user = mapUser(userRow);
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/users/setup-password', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ error: 'Missing userId or password' });
    }
    const uuid = toUUID(userId);
    
    // Check if the user exists and has no password hash set
    const checkSql = 'SELECT id, role, password_hash FROM users WHERE id = $1';
    const { rows: checkRows } = await pool.query(checkSql, [uuid]);
    if (checkRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = checkRows[0];
    if (user.password_hash && user.password_hash !== '' && user.password_hash !== 'UNSET') {
      return res.status(400).json({ error: 'Password already set' });
    }
    
    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Update password in database
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, uuid]);
    
    // Fetch full user data to return
    const sql = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role,
             sp.accessibility_profile as profile_id, sp.grade_level,
             (SELECT class_id FROM class_students WHERE student_id = u.id LIMIT 1) as class_id,
             sp.preferred_language,
             (SELECT COALESCE(json_agg(support_need), '[]'::json) FROM student_accessibility_needs WHERE student_id = u.id AND is_active = true) as support_needs,
             (SELECT COALESCE(json_agg(student_id), '[]'::json) FROM parent_student_links WHERE parent_id = u.id) as linked_student_ids
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      WHERE u.id = $1
    `;
    const { rows } = await pool.query(sql, [uuid]);
    const fullUser = mapUser(rows[0]);
    
    // Sign token
    const token = jwt.sign({ id: fullUser.id, role: fullUser.role }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ user: fullUser, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/users/:id', authenticateToken, async (req, res) => {
  try {
    const userId = toUUID(req.params.id);
    const { firstName, lastName, email, profileId, gradeLevel } = req.body;

    if (firstName || lastName || email) {
      let updates = [];
      let params = [userId];
      if (firstName) {
        updates.push(`first_name = $${params.length + 1}`);
        params.push(firstName);
      }
      if (lastName) {
        updates.push(`last_name = $${params.length + 1}`);
        params.push(lastName);
      }
      if (email) {
        updates.push(`email = $${params.length + 1}`);
        params.push(email);
      }
      const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = $1`;
      await pool.query(sql, params);
    }

    const preferredLanguage = req.body.preferredLanguage;
    if (profileId || gradeLevel || preferredLanguage) {
      let updates = [];
      let params = [userId];
      if (profileId) {
        updates.push(`accessibility_profile = $${params.length + 1}`);
        params.push(profileId);
      }
      if (gradeLevel) {
        updates.push(`grade_level = $${params.length + 1}`);
        params.push(gradeLevel);
      }
      if (preferredLanguage) {
        updates.push(`preferred_language = $${params.length + 1}`);
        params.push(preferredLanguage);
      }
      const sql = `UPDATE student_profiles SET ${updates.join(', ')} WHERE user_id = $1`;
      await pool.query(sql, params);
    }

    // Return updated user
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role,
             sp.accessibility_profile as profile_id, sp.grade_level, sp.class_id, sp.preferred_language,
             (SELECT COALESCE(json_agg(support_need), '[]'::json) FROM student_accessibility_needs WHERE student_id = u.id AND is_active = true) as support_needs,
             (SELECT COALESCE(json_agg(student_id), '[]'::json) FROM parent_student_links WHERE parent_id = u.id) as linked_student_ids
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      WHERE u.id = $1
    `, [userId]);
    res.json(mapUser(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Classes
app.get('/classes', authenticateToken, async (req, res) => {
  try {
    let sql = `
      SELECT c.*, (SELECT count(*) FROM class_students WHERE class_id = c.id) as student_count
      FROM classes c
    `;
    let params = [];
    if (req.query.teacherId) {
      sql += ' WHERE c.teacher_id = $1';
      params.push(toUUID(req.query.teacherId));
    }
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(c => ({
      id: toShortID(c.id),
      teacherId: toShortID(c.teacher_id),
      subjectId: toShortID(c.subject_id),
      name: c.name,
      studentCount: parseInt(c.student_count || 0, 10),
      focus: c.focus
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/classes', authenticateToken, async (req, res) => {
  try {
    const { name, teacherId, subjectId, focus, gradeLevel } = req.body;
    const sql = `
      INSERT INTO classes (name, teacher_id, subject_id, focus, grade_level)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [name, toUUID(teacherId), toUUID(subjectId, 'subj'), focus, gradeLevel || '8']);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/classes/:id', authenticateToken, async (req, res) => {
  try {
    const classId = toUUID(req.params.id, 'class');
    const { teacherId } = req.body;
    const sql = `
      UPDATE classes 
      SET teacher_id = $1 
      WHERE id = $2 
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [teacherId ? toUUID(teacherId) : null, classId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Class not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ClassStudents
app.get('/classStudents', authenticateToken, async (req, res) => {
  try {
    let sql = `
      SELECT cs.class_id, cs.student_id, u.first_name, u.last_name, u.email, sp.accessibility_profile as profile_id, sp.grade_level as grade
      FROM class_students cs
      JOIN users u ON cs.student_id = u.id
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
    `;
    let params = [];
    if (req.query.classId) {
      sql += ' WHERE cs.class_id = $1';
      params.push(toUUID(req.query.classId, 'class'));
    }
    const { rows } = await pool.query(sql, params);
    res.json(rows.map((row, idx) => ({
      id: String(idx + 1),
      classId: toShortID(row.class_id),
      studentId: toShortID(row.student_id),
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      profileId: row.profile_id ? (row.profile_id.charAt(0).toUpperCase() + row.profile_id.slice(1)) : 'Typical',
      gradeLevel: row.grade ? row.grade : '8',
      performance: 'Excellent'
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assignments
app.get('/assignments', authenticateToken, async (req, res) => {
  try {
    let sql = 'SELECT * FROM assignments';
    let params = [];
    
    if (req.query.studentId) {
      sql = `
        SELECT a.*, s.status, s.grade, s.feedback, s.file_url
        FROM assignments a
        JOIN class_students cs ON a.class_id = cs.class_id
        LEFT JOIN assignment_submissions s ON a.id = s.assignment_id AND s.student_id = cs.student_id
        WHERE cs.student_id = $1
      `;
      params.push(toUUID(req.query.studentId));
    } else if (req.query.classId) {
      sql = 'SELECT * FROM assignments WHERE class_id = $1';
      params.push(toUUID(req.query.classId, 'class'));
    }

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(a => ({
      id: toShortID(a.id),
      classId: toShortID(a.class_id),
      lessonId: toShortID(a.lesson_id),
      title: a.title,
      subject: a.subject,
      instructions: a.instructions,
      dueDate: new Date(a.due_at).toLocaleDateString(),
      status: a.status || 'Incomplete',
      grade: a.grade,
      feedback: a.feedback
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/assignments', authenticateToken, async (req, res) => {
  try {
    const { title, subject, instructions, dueDate, classId } = req.body;
    
    // Parse date safely to avoid database crash on empty/invalid inputs
    let parsedDate = new Date(dueDate);
    if (isNaN(parsedDate.getTime())) {
      parsedDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // Default to tomorrow
    }

    const sql = `
      INSERT INTO assignments (class_id, title, subject, instructions, due_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [toUUID(classId, 'class'), title, subject, instructions, parsedDate]);
    const assignment = rows[0];
    if (assignment) {
      const studentsRes = await pool.query('SELECT student_id FROM class_students WHERE class_id = $1', [toUUID(classId, 'class')]);
      for (const studentRow of studentsRes.rows) {
        const studentId = studentRow.student_id;
        await sendSystemNotification(
          studentId,
          'email',
          `New Assignment: ${title}`,
          `Hi, a new assignment '${title}' has been posted for ${subject}. Due date: ${new Date(dueDate).toLocaleDateString()}.`,
          'assignment',
          assignment.id
        );
      }
    }
    res.status(201).json(assignment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/assignments/:id', authenticateToken, async (req, res) => {
  try {
    const id = toUUID(req.params.id, 'assign');
    const { status, grade, feedback } = req.body;
    const reqStudentId = req.body.studentId ? toUUID(req.body.studentId) : null;
    
    // Check if we are updating submissions
    if (status || grade || feedback) {
      // Find a student associated with the submission to update
      const checkSql = 'SELECT student_id FROM assignment_submissions WHERE assignment_id = $1 LIMIT 1';
      const { rows: checkRows } = await pool.query(checkSql, [id]);
      const studentId = reqStudentId || (checkRows[0] ? checkRows[0].student_id : '00000000-0000-0000-0000-000000000001');

      const sql = `
        INSERT INTO assignment_submissions (assignment_id, student_id, status, grade, feedback)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (assignment_id, student_id)
        DO UPDATE SET status = EXCLUDED.status, grade = EXCLUDED.grade, feedback = EXCLUDED.feedback
        RETURNING *
      `;
      await pool.query(sql, [id, studentId, status || 'Submitted', grade, feedback]);

      // If graded, trigger notifications
      if (status === 'Graded' || grade || feedback) {
        const studentRes = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [studentId]);
        const studentName = studentRes.rows[0] ? `${studentRes.rows[0].first_name} ${studentRes.rows[0].last_name}` : 'Student';

        const assignRes = await pool.query('SELECT title, subject FROM assignments WHERE id = $1', [id]);
        const assignTitle = assignRes.rows[0] ? assignRes.rows[0].title : 'Assignment';
        const subject = assignRes.rows[0] ? assignRes.rows[0].subject : 'Subject';

        const parentRes = await pool.query('SELECT parent_id FROM parent_student_links WHERE student_id = $1', [studentId]);
        const parentIds = parentRes.rows.map(r => r.parent_id);

        await sendSystemNotification(
          studentId,
          'email',
          `Assignment Graded: ${assignTitle}`,
          `Hi ${studentName}, your assignment '${assignTitle}' for ${subject} has been graded.\nGrade: ${grade}\nFeedback: ${feedback || 'None'}`,
          'assignment',
          id
        );

        for (const parentId of parentIds) {
          await sendSystemNotification(
            parentId,
            'whatsapp',
            `Assignment Graded`,
            `Hi, your child ${studentName}'s assignment '${assignTitle}' for ${subject} has been graded.\nGrade: ${grade}\nFeedback: ${feedback || 'None'}`,
            'assignment',
            id
          );
        }
      }
    }
    
    const { rows } = await pool.query('SELECT * FROM assignments WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/assignments/:id/extend', authenticateToken, async (req, res) => {
  try {
    const id = toUUID(req.params.id, 'assign');
    const assignRes = await pool.query('SELECT * FROM assignments WHERE id = $1', [id]);
    if (assignRes.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const assignment = assignRes.rows[0];
    const currentDue = new Date(assignment.due_at);
    currentDue.setDate(currentDue.getDate() + 3);
    
    const updateRes = await pool.query(
      'UPDATE assignments SET due_at = $1 WHERE id = $2 RETURNING *',
      [currentDue, id]
    );
    const updatedAssignment = updateRes.rows[0];
    
    const studentId = req.user.id;
    const studentRes = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [studentId]);
    const studentName = studentRes.rows[0] ? `${studentRes.rows[0].first_name} ${studentRes.rows[0].last_name}` : 'Student';
    
    const parentRes = await pool.query('SELECT parent_id FROM parent_student_links WHERE student_id = $1', [studentId]);
    const parentIds = parentRes.rows.map(r => r.parent_id);
    
    const newDueDateStr = currentDue.toLocaleDateString();
    
    await sendSystemNotification(
      studentId,
      'email',
      `Assignment Deadline Extended: ${assignment.title}`,
      `Hi ${studentName}, your request for a deadline extension for '${assignment.title}' has been approved under your Accommodation Plan. Your new due date is ${newDueDateStr}.`,
      'assignment',
      id
    );
    
    for (const parentId of parentIds) {
      await sendSystemNotification(
        parentId,
        'whatsapp',
        `Deadline Extension Approved`,
        `Hi, your child ${studentName}'s deadline for assignment '${assignment.title}' has been extended by 3 days under their Accommodation Plan. New due date: ${newDueDateStr}.`,
        'assignment',
        id
      );
    }
    
    res.json({
      id: toShortID(updatedAssignment.id),
      classId: toShortID(updatedAssignment.class_id),
      lessonId: toShortID(updatedAssignment.lesson_id),
      title: updatedAssignment.title,
      subject: updatedAssignment.subject,
      instructions: updatedAssignment.instructions,
      dueDate: new Date(updatedAssignment.due_at).toLocaleDateString(),
      status: updatedAssignment.status || 'Incomplete'
    });
  } catch (err) {
    console.error('Error extending assignment deadline:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.get('/assignments/:id/submissions', authenticateToken, async (req, res) => {
  try {
    const id = toUUID(req.params.id, 'assign');
    const sql = `
      SELECT s.*, u.first_name, u.last_name 
      FROM assignment_submissions s
      JOIN users u ON s.student_id = u.id
      WHERE s.assignment_id = $1
    `;
    const { rows } = await pool.query(sql, [id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/assignments/:id/submit', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const id = toUUID(req.params.id, 'assign');
    const studentId = req.body.studentId ? toUUID(req.body.studentId) : '00000000-0000-0000-0000-000000000001';
    const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const notes = req.body.notes || null;
    
    const sql = `
      INSERT INTO assignment_submissions (assignment_id, student_id, status, file_url, notes)
      VALUES ($1, $2, 'Submitted', $3, $4)
      ON CONFLICT (assignment_id, student_id)
      DO UPDATE SET status = 'Submitted', 
                    file_url = COALESCE(EXCLUDED.file_url, assignment_submissions.file_url),
                    notes = COALESCE(EXCLUDED.notes, assignment_submissions.notes)
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [id, studentId, fileUrl, notes]);
    const submission = rows[0];

    if (submission) {
      const studentRes = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [studentId]);
      const studentName = studentRes.rows[0] ? `${studentRes.rows[0].first_name} ${studentRes.rows[0].last_name}` : 'Student';

      const assignRes = await pool.query('SELECT title, subject FROM assignments WHERE id = $1', [id]);
      const assignTitle = assignRes.rows[0] ? assignRes.rows[0].title : 'Assignment';
      const subject = assignRes.rows[0] ? assignRes.rows[0].subject : 'Subject';

      const parentRes = await pool.query('SELECT parent_id FROM parent_student_links WHERE student_id = $1', [studentId]);
      const parentIds = parentRes.rows.map(r => r.parent_id);

      await sendSystemNotification(
        studentId,
        'email',
        `Assignment Submitted: ${assignTitle}`,
        `Hi ${studentName}, your assignment '${assignTitle}' for ${subject} has been successfully submitted.`,
        'assignment',
        id
      );

      for (const parentId of parentIds) {
        await sendSystemNotification(
          parentId,
          'whatsapp',
          `Assignment Submitted`,
          `Hi, your child ${studentName} has successfully submitted the assignment '${assignTitle}' for ${subject}.`,
          'assignment',
          id
        );
      }
    }

    res.json(submission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exams
app.get('/exams', authenticateToken, async (req, res) => {
  try {
    let sql = 'SELECT * FROM exams';
    let params = [];

    if (req.query.studentId) {
      sql = `
        SELECT e.*, ea.id AS attempt_id, ea.status, ea.score, ea.feedback
        FROM exams e
        JOIN class_students cs ON e.class_id = cs.class_id
        LEFT JOIN exam_attempts ea ON e.id = ea.exam_id AND ea.student_id = cs.student_id
        WHERE cs.student_id = $1
      `;
      params.push(toUUID(req.query.studentId));
    } else if (req.query.teacherId) {
      sql = 'SELECT * FROM exams WHERE created_by = $1';
      params.push(toUUID(req.query.teacherId));
    }

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(e => ({
      id: toShortID(e.id),
      classId: toShortID(e.class_id),
      title: e.title,
      description: e.description,
      priority: e.priority === 'High Priority' ? 'High Priority' : 'Normal',
      date: new Date(e.scheduled_at).toLocaleDateString(),
      status: e.status || 'Not Started',
      score: e.score,
      feedback: e.feedback,
      attemptId: e.attempt_id ? toShortID(e.attempt_id) : null
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/exams', authenticateToken, async (req, res) => {
  try {
    const { title, priority, date, description, classId, teacherId, generateWithAI } = req.body;
    
    // Parse date safely to avoid database crash on empty/invalid date inputs
    let parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      parsedDate = new Date();
    }

    const sql = `
      INSERT INTO exams (class_id, title, description, priority, scheduled_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [
      toUUID(classId, 'class'),
      title,
      description,
      priority === 'High Priority' ? 'High Priority' : 'Normal',
      parsedDate,
      toUUID(teacherId)
    ]);
    const exam = rows[0];

    if (exam) {
      // 1. Generate questions using AI if requested
      if (generateWithAI) {
        try {
          const subjectRes = await pool.query(
            'SELECT s.name FROM classes c JOIN subjects s ON c.subject_id = s.id WHERE c.id = $1',
            [toUUID(classId, 'class')]
          );
          const subject = subjectRes.rows[0] ? subjectRes.rows[0].name : 'Science';

          const aiRes = await fetch(`${AI_ENGINE_URL}/generate_exam_questions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject, description })
          });

          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const generated = aiData.questions || [];

            for (const q of generated) {
              const qId = require('crypto').randomUUID();
              await pool.query(
                `INSERT INTO exam_questions (id, exam_id, position, question_type, prompt, options, correct_answer, accessibility_notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  qId,
                  exam.id,
                  q.position,
                  q.question_type,
                  q.prompt,
                  q.options ? JSON.stringify(q.options) : null,
                  q.correct_answer,
                  JSON.stringify(q.accessibility_notes || {})
                ]
              );
            }
            console.log(`Successfully generated and inserted ${generated.length} questions for exam ${exam.id}`);
          } else {
            console.warn('AI engine failed to generate questions, status:', aiRes.status);
          }
        } catch (aiErr) {
          console.warn('Failed to call AI engine for question generation:', aiErr.message);
        }
      } else if (req.body.questions && Array.isArray(req.body.questions)) {
        try {
          const manualQuestions = req.body.questions;
          for (let i = 0; i < manualQuestions.length; i++) {
            const q = manualQuestions[i];
            const qId = require('crypto').randomUUID();
            await pool.query(
              `INSERT INTO exam_questions (id, exam_id, position, question_type, prompt, options, correct_answer, accessibility_notes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                qId,
                exam.id,
                i + 1,
                q.type || q.question_type || 'mcq',
                q.prompt,
                q.options ? JSON.stringify(q.options) : null,
                q.correct_answer || q.correctAnswer,
                JSON.stringify(q.accessibility_notes || {})
              ]
            );
          }
          console.log(`Successfully inserted ${manualQuestions.length} manual questions for exam ${exam.id}`);
        } catch (manErr) {
          console.warn('Failed to insert manual exam questions:', manErr.message);
        }
      }

      // 2. Dispatch notifications
      const studentsRes = await pool.query('SELECT student_id FROM class_students WHERE class_id = $1', [toUUID(classId, 'class')]);
      
      const subjectRes = await pool.query('SELECT s.name FROM classes c JOIN subjects s ON c.subject_id = s.id WHERE c.id = $1', [toUUID(classId, 'class')]);
      const subject = subjectRes.rows[0] ? subjectRes.rows[0].name : 'Subject';

      for (const studentRow of studentsRes.rows) {
        const studentId = studentRow.student_id;
        await sendSystemNotification(
          studentId,
          'email',
          `New Exam Scheduled: ${title}`,
          `Hi, a new exam '${title}' for ${subject} has been scheduled on ${parsedDate.toLocaleDateString()}. Priority: ${priority || 'Normal'}.`,
          'exam',
          exam.id
        );
      }
    }

    res.status(201).json(exam);
  } catch (err) {
    console.error('Failed to create exam:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/exams/generate-questions', authenticateToken, async (req, res) => {
  try {
    const { classId, description, fileUrl, numMcqs, numShort, numDescriptive } = req.body;
    console.log(`[Exam Generator] Received request for classId: ${classId}, fileUrl: ${fileUrl}, numMcqs: ${numMcqs}, numShort: ${numShort}, numDescriptive: ${numDescriptive}`);
    
    let subject = 'Science';
    if (classId) {
      const subjectRes = await pool.query(
        'SELECT s.name FROM classes c JOIN subjects s ON c.subject_id = s.id WHERE c.id = $1',
        [toUUID(classId, 'class')]
      );
      if (subjectRes.rows[0]) {
        subject = subjectRes.rows[0].name;
      }
    }
    console.log(`[Exam Generator] Determined subject: ${subject}`);

    let context = '';
    if (fileUrl) {
      const decodedUrl = decodeURIComponent(fileUrl);
      const filename = path.basename(decodedUrl);
      const filePath = path.join(__dirname, 'uploads', filename);
      console.log(`[Exam Generator] Resolved file path: ${filePath}`);
      
      if (fs.existsSync(filePath)) {
        console.log(`[Exam Generator] File exists. Parsing file...`);
        const fileExt = path.extname(filePath).toLowerCase();
        if (fileExt === '.txt') {
          context = fs.readFileSync(filePath, 'utf-8');
        } else if (fileExt === '.docx') {
          const result = await mammoth.extractRawText({ path: filePath });
          context = result.value || '';
        } else if (fileExt === '.epub') {
          const { parseEpub } = require('@gxl/epub-parser');
          const epubObj = await parseEpub(filePath, { type: 'path' });
          const texts = [];
          for (const section of epubObj.sections) {
            const html = section.htmlString || '';
            const plainText = html.replace(/<[^>]*>/g, ' ');
            if (plainText.trim()) {
              texts.push(plainText);
            }
          }
          context = texts.join('\n\n');
        } else if (fileExt === '.pdf') {
          const { PDFParse } = require('pdf-parse');
          const dataBuffer = fs.readFileSync(filePath);
          const parser = new PDFParse({ data: dataBuffer });
          const pdfData = await parser.getText();
          context = pdfData.text || '';
          await parser.destroy();
        }
        console.log(`[Exam Generator] File parsed successfully. Extracted context length: ${context.length}`);
      } else {
        console.warn(`[Exam Generator] Warning: Resolved file path does not exist on disk: ${filePath}`);
      }
    } else {
      console.log(`[Exam Generator] No reference material URL provided.`);
    }

    console.log(`[Exam Generator] Forwarding request to AI Engine with context length: ${context.length}`);
    const aiRes = await fetch(`${AI_ENGINE_URL}/generate_exam_questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        subject, 
        description, 
        context, 
        num_mcqs: numMcqs, 
        num_short: numShort,
        num_descriptive: numDescriptive
      })
    });
    if (aiRes.ok) {
      const aiData = await aiRes.json();
      console.log(`[Exam Generator] AI Engine returned ${aiData.questions ? aiData.questions.length : 0} questions.`);
      return res.json(aiData);
    } else {
      const errText = await aiRes.text();
      console.error(`[Exam Generator] AI Engine returned error: ${errText}`);
      return res.status(aiRes.status).json({ error: errText });
    }
  } catch (err) {
    console.error('Failed to generate questions using AI:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/exams/:id/questions', authenticateToken, async (req, res) => {
  try {
    const examId = toUUID(req.params.id, 'exam');
    const profile = req.query.profile || 'typical';

    const { rows } = await pool.query(
      'SELECT id, prompt, question_type as "type", options, correct_answer, accessibility_notes FROM exam_questions WHERE exam_id = $1 ORDER BY position ASC',
      [examId]
    );
    
    const baseQuestions = rows.map(q => ({
      id: toShortID(q.id),
      prompt: q.prompt,
      type: q.type,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : (q.options || null),
      correctAnswer: q.correct_answer,
      accessibilityNotes: typeof q.accessibility_notes === 'string' ? JSON.parse(q.accessibility_notes) : (q.accessibility_notes || null)
    }));

    if (profile === 'typical') {
      return res.json(baseQuestions);
    }

    try {
      const response = await fetch(`${AI_ENGINE_URL}/adapt_questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, questions: baseQuestions })
      });
      if (response.ok) {
        const data = await response.json();
        return res.json(data.questions);
      } else {
        console.warn('AI engine failed to adapt questions, status:', response.status);
      }
    } catch (e) {
      console.warn('Failed to connect to AI engine for question adaptation:', e.message);
    }

    res.json(baseQuestions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Exam Attempt
app.post('/exams/:id/start', authenticateToken, async (req, res) => {
  try {
    const examId = toUUID(req.params.id, 'exam');
    const { studentId } = req.body;
    const sId = toUUID(studentId);

    if (!sId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // Check if an attempt already exists
    const checkSql = 'SELECT * FROM exam_attempts WHERE exam_id = $1 AND student_id = $2';
    const { rows: checkRows } = await pool.query(checkSql, [examId, sId]);

    if (checkRows.length > 0) {
      const attempt = checkRows[0];
      if (attempt.status === 'Submitted' || attempt.status === 'Reviewed') {
        return res.status(400).json({ error: 'Exam has already been submitted.' });
      }
      return res.json({
        id: toShortID(attempt.id),
        examId: toShortID(attempt.exam_id),
        studentId: toShortID(attempt.student_id),
        status: attempt.status,
        startedAt: attempt.started_at,
        score: attempt.score,
        feedback: attempt.feedback
      });
    }

    // Create a new attempt
    const attemptId = require('crypto').randomUUID();
    const insertSql = `
      INSERT INTO exam_attempts (id, exam_id, student_id, status, started_at)
      VALUES ($1, $2, $3, 'In Progress', NOW())
      RETURNING *
    `;
    const { rows: insertRows } = await pool.query(insertSql, [attemptId, examId, sId]);
    const newAttempt = insertRows[0];

    res.status(201).json({
      id: toShortID(newAttempt.id),
      examId: toShortID(newAttempt.exam_id),
      studentId: toShortID(newAttempt.student_id),
      status: newAttempt.status,
      startedAt: newAttempt.started_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit Exam Answers
app.post('/exams/:id/submit', authenticateToken, async (req, res) => {
  try {
    const examId = toUUID(req.params.id, 'exam');
    const { studentId, answers } = req.body; // answers: { [questionId]: answerText }
    const sId = toUUID(studentId);

    if (!sId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // Retrieve or create attempt
    const checkSql = "SELECT * FROM exam_attempts WHERE exam_id = $1 AND student_id = $2";
    const { rows: checkRows } = await pool.query(checkSql, [examId, sId]);

    let attemptId;
    if (checkRows.length === 0) {
      attemptId = require('crypto').randomUUID();
      await pool.query(
        `INSERT INTO exam_attempts (id, exam_id, student_id, status, started_at)
         VALUES ($1, $2, $3, 'In Progress', NOW())`,
        [attemptId, examId, sId]
      );
    } else {
      const attempt = checkRows[0];
      if (attempt.status === 'Submitted' || attempt.status === 'Reviewed') {
        return res.json({
          id: toShortID(attempt.id),
          examId: toShortID(attempt.exam_id),
          studentId: toShortID(attempt.student_id),
          status: attempt.status,
          submittedAt: attempt.submitted_at,
          score: attempt.score,
          feedback: attempt.feedback
        });
      }
      attemptId = attempt.id;
    }

    // Fetch the exam questions to auto-grade MCQs
    const { rows: questions } = await pool.query(
      'SELECT id, prompt, question_type, correct_answer FROM exam_questions WHERE exam_id = $1',
      [examId]
    );

    // Fetch lesson context for RAG verification of descriptive answers
    let contextList = [];
    try {
      const lessonsRes = await pool.query(
        `SELECT l.title, l.full_text 
         FROM lessons l 
         JOIN classes c ON l.subject_id = c.subject_id 
         WHERE c.id = (SELECT class_id FROM exams WHERE id = $1)`,
        [examId]
      );
      contextList = lessonsRes.rows.map(row => ({
        title: row.title,
        text: row.full_text || ''
      }));
    } catch (e) {
      console.warn('Failed to load lesson context for RAG grading:', e.message);
    }

    let totalScore = 0;
    let anyGradingFailed = false;

    // Delete any existing answers for this attempt (idempotency)
    await pool.query('DELETE FROM exam_answers WHERE attempt_id = $1', [attemptId]);

    for (const q of questions) {
      const studentAnswer = answers[toShortID(q.id)] || answers[q.id] || '';
      let isCorrect = null;
      let score = null;
      let feedback = null;

      if (q.question_type === 'mcq') {
        const cleanStudent = studentAnswer.trim().toLowerCase();
        const cleanCorrect = (q.correct_answer || '').trim().toLowerCase();
        isCorrect = cleanStudent === cleanCorrect;
        score = isCorrect ? 10.0 : 0.0;
        totalScore += score;
      } else {
        // Automated RAG AI Grading for short / descriptive answers
        try {
          const response = await fetch(`${AI_ENGINE_URL}/verify_answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question_prompt: q.prompt,
              correct_answer: q.correct_answer,
              student_answer: studentAnswer,
              context: contextList
            })
          });
          if (response.ok) {
            const data = await response.json();
            isCorrect = data.is_correct;
            score = data.score;
            feedback = data.explanation;
            totalScore += score;
          } else {
            console.warn('AI engine failed to verify answer, status:', response.status);
            feedback = 'AI engine unavailable for automated grading. Awaiting teacher review.';
            anyGradingFailed = true;
          }
        } catch (err) {
          console.warn('Failed to connect to AI engine for answer verification:', err.message);
          feedback = 'AI engine offline. Awaiting teacher review.';
          anyGradingFailed = true;
        }
      }

      const answerId = require('crypto').randomUUID();
      await pool.query(
        `INSERT INTO exam_answers (id, attempt_id, question_id, answer, is_correct, score, feedback)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [answerId, attemptId, q.id, studentAnswer, isCorrect, score, feedback]
      );
    }

    // If grading of any descriptive question failed, mark as 'Submitted' for manual grading, else 'Reviewed'
    const newStatus = anyGradingFailed ? 'Submitted' : 'Reviewed';
    const finalScore = anyGradingFailed ? null : totalScore;

    const updateSql = `
      UPDATE exam_attempts 
      SET status = $1, submitted_at = NOW(), score = $2
      WHERE id = $3
      RETURNING *
    `;
    const { rows: updateRows } = await pool.query(updateSql, [newStatus, finalScore, attemptId]);
    const attempt = updateRows[0];

    if (attempt) {
      const studentRes = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [sId]);
      const studentName = studentRes.rows[0] ? `${studentRes.rows[0].first_name} ${studentRes.rows[0].last_name}` : 'Student';

      const examRes = await pool.query('SELECT title, class_id FROM exams WHERE id = $1', [examId]);
      const examTitle = examRes.rows[0] ? examRes.rows[0].title : 'Exam';
      const classIdVal = examRes.rows[0] ? examRes.rows[0].class_id : null;
      let subject = 'Subject';
      if (classIdVal) {
        const subjectRes = await pool.query('SELECT s.name FROM classes c JOIN subjects s ON c.subject_id = s.id WHERE c.id = $1', [classIdVal]);
        subject = subjectRes.rows[0] ? subjectRes.rows[0].name : 'Subject';
      }

      const parentRes = await pool.query('SELECT parent_id FROM parent_student_links WHERE student_id = $1', [sId]);
      const parentIds = parentRes.rows.map(r => r.parent_id);

      await sendSystemNotification(
        sId,
        'email',
        `Exam Submitted: ${examTitle}`,
        `Hi ${studentName}, your exam '${examTitle}' for ${subject} has been successfully submitted. Status: ${attempt.status}.`,
        'exam',
        examId
      );

      for (const parentId of parentIds) {
        await sendSystemNotification(
          parentId,
          'whatsapp',
          `Exam Submitted`,
          `Hi, your child ${studentName} has successfully submitted the exam '${examTitle}' for ${subject}. Status: ${attempt.status}.`,
          'exam',
          examId
        );
      }
    }

    res.json({
      id: toShortID(attempt.id),
      examId: toShortID(attempt.exam_id),
      studentId: toShortID(attempt.student_id),
      status: attempt.status,
      submittedAt: attempt.submitted_at,
      score: attempt.score,
      feedback: attempt.feedback
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Exam Attempts for a specific Exam
app.get('/exams/:id/attempts', authenticateToken, async (req, res) => {
  try {
    const examId = toUUID(req.params.id, 'exam');
    const sql = `
      SELECT ea.*, u.first_name, u.last_name, u.email
      FROM exam_attempts ea
      JOIN users u ON ea.student_id = u.id
      WHERE ea.exam_id = $1
      ORDER BY ea.submitted_at DESC
    `;
    const { rows } = await pool.query(sql, [examId]);
    res.json(rows.map(row => ({
      id: toShortID(row.id),
      examId: toShortID(row.exam_id),
      studentId: toShortID(row.student_id),
      studentName: `${row.first_name} ${row.last_name}`,
      studentEmail: row.email,
      status: row.status,
      startedAt: row.started_at,
      submittedAt: row.submitted_at,
      score: row.score,
      feedback: row.feedback
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Exam Attempt Details by Attempt ID
app.get('/exams/attempts/:attemptId', authenticateToken, async (req, res) => {
  try {
    const attemptId = toUUID(req.params.attemptId);
    
    const attemptSql = `
      SELECT ea.*, e.title as exam_title, e.description as exam_description, u.first_name, u.last_name
      FROM exam_attempts ea
      JOIN exams e ON ea.exam_id = e.id
      JOIN users u ON ea.student_id = u.id
      WHERE ea.id = $1
    `;
    const { rows: attemptRows } = await pool.query(attemptSql, [attemptId]);
    if (attemptRows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    const attempt = attemptRows[0];

    const answersSql = `
      SELECT ea.id as answer_id, ea.question_id, ea.answer, ea.is_correct, ea.score as question_score, ea.feedback as question_feedback,
             eq.prompt, eq.question_type, eq.options, eq.correct_answer, eq.accessibility_notes
      FROM exam_answers ea
      JOIN exam_questions eq ON ea.question_id = eq.id
      WHERE ea.attempt_id = $1
      ORDER BY eq.position ASC
    `;
    const { rows: answersRows } = await pool.query(answersSql, [attemptId]);

    res.json({
      id: toShortID(attempt.id),
      examId: toShortID(attempt.exam_id),
      examTitle: attempt.exam_title,
      examDescription: attempt.exam_description,
      studentId: toShortID(attempt.student_id),
      studentName: `${attempt.first_name} ${attempt.last_name}`,
      status: attempt.status,
      startedAt: attempt.started_at,
      submittedAt: attempt.submitted_at,
      score: attempt.score,
      feedback: attempt.feedback,
      answers: answersRows.map(a => ({
        id: toShortID(a.answer_id),
        questionId: toShortID(a.question_id),
        answer: a.answer,
        isCorrect: a.is_correct,
        score: a.question_score,
        feedback: a.question_feedback,
        prompt: a.prompt,
        type: a.question_type,
        options: typeof a.options === 'string' ? JSON.parse(a.options) : (a.options || null),
        correctAnswer: a.correct_answer,
        accessibilityNotes: typeof a.accessibility_notes === 'string' ? JSON.parse(a.accessibility_notes) : (a.accessibility_notes || null)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teacher Grade Exam Attempt
app.post('/exams/attempts/:attemptId/grade', authenticateToken, async (req, res) => {
  try {
    const attemptId = toUUID(req.params.attemptId);
    const { grades, overallFeedback } = req.body; // grades: { [questionId]: { score: number, feedback: string } }

    for (const [qId, grade] of Object.entries(grades)) {
      const uuidQId = toUUID(qId);
      await pool.query(
        `UPDATE exam_answers 
         SET score = $1, feedback = $2
         WHERE attempt_id = $3 AND question_id = $4`,
        [grade.score, grade.feedback, attemptId, uuidQId]
      );
    }

    // Calculate total score
    const scoreRes = await pool.query(
      'SELECT SUM(score) as total FROM exam_answers WHERE attempt_id = $1',
      [attemptId]
    );
    const totalScore = parseFloat(scoreRes.rows[0].total || 0);

    // Update attempt
    const updateSql = `
      UPDATE exam_attempts
      SET status = 'Reviewed', score = $1, feedback = $2
      WHERE id = $3
      RETURNING *
    `;
    const { rows } = await pool.query(updateSql, [totalScore, overallFeedback, attemptId]);
    const attempt = rows[0];

    if (attempt) {
      const studentId = attempt.student_id;
      const examId = attempt.exam_id;

      // Fetch Student Name
      const studentRes = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [studentId]);
      const studentName = studentRes.rows[0] ? `${studentRes.rows[0].first_name} ${studentRes.rows[0].last_name}` : 'Student';

      // Fetch Exam Title & Subject
      const examRes = await pool.query('SELECT title, class_id FROM exams WHERE id = $1', [examId]);
      const examTitle = examRes.rows[0] ? examRes.rows[0].title : 'Exam';
      const classIdVal = examRes.rows[0] ? examRes.rows[0].class_id : null;
      let subject = 'Subject';
      if (classIdVal) {
        const subjectRes = await pool.query('SELECT s.name FROM classes c JOIN subjects s ON c.subject_id = s.id WHERE c.id = $1', [classIdVal]);
        subject = subjectRes.rows[0] ? subjectRes.rows[0].name : 'Subject';
      }

      // Find linked parents
      const parentRes = await pool.query('SELECT parent_id FROM parent_student_links WHERE student_id = $1', [studentId]);
      const parentIds = parentRes.rows.map(r => r.parent_id);

      // Student Email Notification
      await sendSystemNotification(
        studentId,
        'email',
        `Exam Graded: ${examTitle}`,
        `Hi ${studentName}, your exam '${examTitle}' for ${subject} has been graded.\nScore: ${totalScore}\nFeedback: ${overallFeedback || 'None'}`,
        'exam',
        examId
      );

      // Parents WhatsApp Notifications
      for (const parentId of parentIds) {
        await sendSystemNotification(
          parentId,
          'whatsapp',
          `Exam Graded`,
          `Hi, your child ${studentName}'s exam '${examTitle}' for ${subject} has been graded.\nScore: ${totalScore}\nFeedback: ${overallFeedback || 'None'}`,
          'exam',
          examId
        );
      }
    }

    res.json(attempt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Lessons (PostgreSQL database-driven)
app.get('/lessons', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.lesson_slug as "slug", l.title, s.name as "subject", l.grade_level as "gradeLevel", l.language, l.media, l.vocabulary, l.segments, l.full_text as "fullText"
      FROM lessons l
      LEFT JOIN subjects s ON l.subject_id = s.id
    `);
    
    const lessons = rows.map(row => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      subject: row.subject || 'Science',
      gradeLevel: row.gradeLevel || '8',
      language: row.language || 'en',
      media: typeof row.media === 'string' ? JSON.parse(row.media) : (row.media || []),
      vocabulary: typeof row.vocabulary === 'string' ? JSON.parse(row.vocabulary) : (row.vocabulary || []),
      segments: typeof row.segments === 'string' ? JSON.parse(row.segments) : (row.segments || []),
      fullText: row.fullText || ''
    }));
    
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/lessons/:idOrSlug', authenticateToken, async (req, res) => {
  try {
    const idOrSlug = req.params.idOrSlug;
    const mappedVal = toUUID(idOrSlug);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mappedVal);
    const uuidVal = isUuid ? mappedVal : '00000000-0000-0000-0000-000000000000';
    
    const query = `
      SELECT l.id, l.lesson_slug as "slug", l.title, s.name as "subject", l.grade_level as "gradeLevel", l.language, l.media, l.vocabulary, l.segments, l.full_text as "fullText"
      FROM lessons l
      LEFT JOIN subjects s ON l.subject_id = s.id
      WHERE l.id = $1 OR l.lesson_slug = $2
    `;
    
    const { rows } = await pool.query(query, [uuidVal, idOrSlug]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    
    const row = rows[0];
    const lesson = {
      id: row.id,
      slug: row.slug,
      title: row.title,
      subject: row.subject || 'Science',
      gradeLevel: row.gradeLevel || '8',
      language: row.language || 'en',
      media: typeof row.media === 'string' ? JSON.parse(row.media) : (row.media || []),
      vocabulary: typeof row.vocabulary === 'string' ? JSON.parse(row.vocabulary) : (row.vocabulary || []),
      segments: typeof row.segments === 'string' ? JSON.parse(row.segments) : (row.segments || []),
      fullText: row.fullText || ''
    };
    
    res.json(lesson);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lessons/adapt', authenticateToken, async (req, res) => {
  try {
    const response = await fetch(`${AI_ENGINE_URL}/adapt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    if (!response.ok) {
      console.warn('AI engine returned error, using fallback adaptation:', response.status);
      const fallbackResult = await fallbackAdaptation(req.body.lesson, req.body.profile, req.body.lang || req.body.language);
      return res.json(fallbackResult);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Adaptive engine proxy failed, using fallback adaptation:', err.message);
    try {
      const fallbackResult = await fallbackAdaptation(req.body.lesson, req.body.profile, req.body.lang || req.body.language);
      res.json(fallbackResult);
    } catch (fallbackErr) {
      console.error('Total failure, fallback adaptation also failed:', fallbackErr.message);
      res.status(500).json({ error: 'Failed to adapt lesson content' });
    }
  }
});

// Analytics Event Tracking
app.post('/api/analytics/track', authenticateToken, async (req, res) => {
  try {
    const studentId = req.user.id;
    const { lessonId, eventType, eventValue, metadata } = req.body;
    
    let lId = lessonId ? toUUID(lessonId) : null;
    if (lId) {
      const lessonCheck = await pool.query('SELECT id FROM lessons WHERE id = $1', [lId]);
      if (lessonCheck.rows.length === 0) {
        lId = null;
      }
    }
    
    let classId = null;
    if (lId) {
      const classRes = await pool.query(`
        SELECT cs.class_id 
        FROM class_students cs 
        JOIN lessons l ON cs.student_id = $1 
        WHERE l.id = $2 LIMIT 1
      `, [studentId, lId]);
      if (classRes.rows.length > 0) {
        classId = classRes.rows[0].class_id;
      }
    }
    
    await pool.query(`
      INSERT INTO analytics_events (student_id, class_id, lesson_id, event_type, event_value, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [studentId, classId, lId, eventType, eventValue || 1, JSON.stringify(metadata || {})]);
    
    if (lId) {
      const profRes = await pool.query('SELECT accessibility_profile FROM student_profiles WHERE user_id = $1', [studentId]);
      const profile = profRes.rows.length > 0 ? profRes.rows[0].accessibility_profile : 'typical';
      
      const timeSpent = eventType === 'lesson_viewed' ? parseInt(eventValue, 10) : 0;
      const downloads = eventType === 'content_downloaded' ? 1 : 0;
      
      const activityCheck = await pool.query('SELECT * FROM lesson_activity WHERE lesson_id = $1 AND student_id = $2 AND accessibility_profile = $3', [lId, studentId, profile]);
      if (activityCheck.rows.length > 0) {
        await pool.query(`
          UPDATE lesson_activity 
          SET time_spent_seconds = time_spent_seconds + $1, 
              downloads_count = downloads_count + $2, 
              last_viewed_at = now() 
          WHERE lesson_id = $3 AND student_id = $4 AND accessibility_profile = $5
        `, [timeSpent, downloads, lId, studentId, profile]);
      } else {
        await pool.query(`
          INSERT INTO lesson_activity (lesson_id, student_id, accessibility_profile, time_spent_seconds, downloads_count, last_viewed_at)
          VALUES ($1, $2, $3, $4, $5, now())
        `, [lId, studentId, profile, timeSpent, downloads]);
      }

      const subjectRes = await pool.query('SELECT subject_id FROM lessons WHERE id = $1', [lId]);
      if (subjectRes.rows.length > 0) {
        const subjectId = subjectRes.rows[0].subject_id;
        
        const totalDlRes = await pool.query('SELECT COALESCE(SUM(downloads_count), 0) as dl FROM lesson_activity WHERE student_id = $1 AND lesson_id IN (SELECT id FROM lessons WHERE subject_id = $2)', [studentId, subjectId]);
        const downloadsCount = parseInt(totalDlRes.rows[0].dl, 10);
        
        const completedAssignRes = await pool.query('SELECT COUNT(*) as count FROM assignment_submissions s JOIN assignments a ON s.assignment_id = a.id WHERE s.student_id = $1 AND a.subject = (SELECT name FROM subjects WHERE id = $2) AND s.status = \'Submitted\'', [studentId, subjectId]);
        const completedCount = parseInt(completedAssignRes.rows[0].count, 10);

        const reportCheck = await pool.query('SELECT * FROM progress_reports WHERE student_id = $1 AND subject_id = $2', [studentId, subjectId]);
        if (reportCheck.rows.length > 0) {
          const totalAssignRes = await pool.query('SELECT COUNT(*) as count FROM assignments WHERE subject = (SELECT name FROM subjects WHERE id = $1)', [subjectId]);
          const totalAssignCount = parseInt(totalAssignRes.rows[0].count, 10) || 1;
          const percentage = Math.min(100, Math.round((completedCount / totalAssignCount) * 100));

          await pool.query(`
            UPDATE progress_reports 
            SET downloads_count = $1, 
                assignments_completed = $2,
                percentage = $3
            WHERE student_id = $4 AND subject_id = $5
          `, [downloadsCount, completedCount, percentage, studentId, subjectId]);
        }
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to log analytics event:', err);
    res.status(500).json({ error: err.message });
  }
});

// Notifications
app.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.query.userId ? toUUID(req.query.userId) : req.user.id;
    const sql = `
      SELECT * FROM notifications 
      WHERE user_id = $1 
         OR user_id IN (SELECT student_id FROM parent_student_links WHERE parent_id = $1)
      ORDER BY sent_at DESC LIMIT 20
    `;
    const { rows } = await pool.query(sql, [userId]);
    res.json(rows.map(r => ({
      id: r.id,
      userId: toShortID(r.user_id),
      channel: r.channel,
      title: r.title,
      body: r.body,
      entityType: r.related_entity_type,
      entityId: toShortID(r.related_entity_id),
      sentAt: r.sent_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Study Materials
app.get('/studyMaterials', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.*, f.storage_key as file_url
      FROM study_materials m
      LEFT JOIN file_assets f ON m.file_asset_id = f.id
    `);
    res.json(rows.map(m => ({
      id: toShortID(m.id),
      classId: toShortID(m.class_id),
      title: m.title,
      subject: m.subject,
      body: m.body,
      mongodbContentId: m.mongodb_content_id,
      fileUrl: m.file_url ? `/uploads/${m.file_url}` : null
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/studyMaterials', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { title, subject, classId, teacherId } = req.body;
    let content = req.body.content || '';
    let fileAssetId = null;

    if (req.file) {
      const fileExt = path.extname(req.file.originalname).toLowerCase();
      const storageKey = req.file.filename;
      const ownerId = toUUID(teacherId) || '20000000-0000-0000-0000-000000000002';
      const fileSql = `
        INSERT INTO file_assets (owner_id, kind, size_bytes, mime_type, storage_key, original_filename)
        VALUES ($1, 'study_material', $2, $3, $4, $5)
        RETURNING id
      `;
      const fileRes = await pool.query(fileSql, [ownerId, req.file.size, req.file.mimetype, storageKey, req.file.originalname]);
      fileAssetId = fileRes.rows[0].id;
      
      if (fileExt === '.docx') {
         const options = {
             convertImage: mammoth.images.imgElement(function(image) {
                 return image.read("base64").then(function(imageBuffer) {
                     const ext = image.contentType.split('/')[1] || 'png';
                     const crypto = require('crypto');
                     const filename = crypto.randomUUID() + '.' + ext;
                     const uploadPath = path.join(uploadDir, filename);
                     fs.writeFileSync(uploadPath, Buffer.from(imageBuffer, 'base64'));
                     return {
                         src: `/uploads/${filename}`
                     };
                 });
             })
         };
         const result = await mammoth.convertToHtml({ path: req.file.path }, options);
         const html = result.value;
         const turndownService = new TurndownService({ headingStyle: 'atx' });
         const markdown = turndownService.turndown(html);
         // Overwrite content with extracted markdown if the content field was empty, or append if it has content
         if (!content.trim()) {
           content = markdown;
         } else {
           content = content + '\n\n' + markdown;
         }
      } else if (fileExt === '.pdf') {
         const { PDFParse } = require('pdf-parse');
         const dataBuffer = fs.readFileSync(req.file.path);
         const parser = new PDFParse({ data: dataBuffer });
         const pdfData = await parser.getText();
         const rawText = pdfData.text || '';
         await parser.destroy();
         const textWithImages = await extractAndEmbedPdfImages(dataBuffer, rawText, uploadDir);
         const cleanText = optimizePdfMarkdown(textWithImages, req.file.originalname);
         if (!content.trim()) {
           content = cleanText;
         } else {
           content = content + '\n\n' + cleanText;
         }
      }
    }

    const sql = `
      INSERT INTO study_materials (class_id, title, subject, body, uploaded_by, file_asset_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [toUUID(classId, 'class'), title, subject, content, toUUID(teacherId), fileAssetId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  // --- Content Management API ---
  app.delete('/books/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM study_materials WHERE book_id = $1', [req.params.id]);
      await pool.query('DELETE FROM books WHERE id = $1', [req.params.id]);
      res.json({ message: 'Book deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/books/:id', authenticateToken, async (req, res) => {
    try {
      const { title, subject } = req.body;
      const { rows } = await pool.query(
        'UPDATE books SET title = COALESCE($1, title), subject = COALESCE($2, subject), updated_at = NOW() WHERE id = $3 RETURNING *',
        [title, subject, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/studyMaterials/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM study_materials WHERE id = $1', [req.params.id]);
      res.json({ message: 'Study material deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/studyMaterials/:id', authenticateToken, async (req, res) => {
    try {
      const { title, subject, body } = req.body;
      const { rows } = await pool.query(
        'UPDATE study_materials SET title = COALESCE($1, title), subject = COALESCE($2, subject), body = COALESCE($3, body), updated_at = NOW() WHERE id = $4 RETURNING *',
        [title, subject, body, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
async function extractAndEmbedPdfImages(dataBuffer, rawText, uploadDir) {
  const { PDFParse } = require('pdf-parse');
  const pageDelimiterRegex = /-- \d+ of \d+ --/g;
  const pageMatches = rawText.split(pageDelimiterRegex);
  const totalPages = pageMatches.length;
  const crypto = require('crypto');

  const pageImagesMap = new Map();
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const parser = new PDFParse({ data: dataBuffer });
    try {
      const promise = parser.getImage({ partial: [pageNum], imageThreshold: 50 });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000));
      const imageResult = await Promise.race([promise, timeout]);
      
      const pageImages = imageResult.pages.find(p => p.pageNumber === pageNum);
      if (pageImages && pageImages.images && pageImages.images.length > 0) {
        pageImagesMap.set(pageNum, pageImages.images);
      }
    } catch (err) {
      console.warn(`[PDF Image Extraction] Page ${pageNum} skipped:`, err.message);
    } finally {
      try {
        await parser.destroy();
      } catch (e) {}
    }
  }

  const modifiedPages = [];
  pageMatches.forEach((pageText, idx) => {
    const pageNum = idx + 1;
    let newPageText = pageText;
    const images = pageImagesMap.get(pageNum);
    if (images && images.length > 0) {
      images.forEach((img, imgIdx) => {
        try {
          const ext = 'png';
          const uploadName = crypto.randomUUID() + '.' + ext;
          const uploadPath = path.join(uploadDir, uploadName);
          fs.writeFileSync(uploadPath, img.data);
          
          const newSrc = `/uploads/${uploadName}`;
          newPageText += `\n\n![Image from page ${pageNum} - Fig ${imgIdx + 1}](${newSrc})`;
        } catch (writeErr) {
          console.error('[PDF Image Extraction] Failed to write image:', writeErr);
        }
      });
    }
    modifiedPages.push(newPageText);
  });

  const delimiters = rawText.match(pageDelimiterRegex) || [];
  let reconstructed = '';
  for (let i = 0; i < modifiedPages.length; i++) {
    reconstructed += modifiedPages[i];
    if (i < delimiters.length) {
      reconstructed += '\n' + delimiters[i] + '\n';
    }
  }
  return reconstructed;
}

function optimizePdfMarkdown(rawText, filename) {
  const pageDelimiterRegex = /-- \d+ of \d+ --/g;
  const pageMatches = rawText.split(pageDelimiterRegex);
  
  const cleanPages = [];
  
  pageMatches.forEach((pageText, idx) => {
    const pageNum = idx + 1;
    
    // Check if this page contains garbled text.
    // Garbled text in this EVS textbook contains characters like ¶, §, •, œ, ü, ≤, etc.
    const garbledRegex = /[¶§•œü≤ÃâÁ™Õßµ†‡ˆ˜¯˘˙˚¸˝˛]/g;
    const garbledCount = (pageText.match(garbledRegex) || []).length;
    
    if (garbledCount > 5) {
      console.log(`Skipping garbled page ${pageNum} (garbled characters count: ${garbledCount})`);
      return;
    }
    
    // Remove lines that are page headers like "Class - 3 : Our Wonderful World \d+"
    let lines = pageText.split('\n');
    lines = lines.filter(line => {
      const trimmed = line.trim();
      if (/^Class\s*-\s*3\s*:\s*Our\s*Wonderful\s*World/i.test(trimmed)) {
        return false;
      }
      return true;
    });
    
    cleanPages.push(lines.join('\n'));
  });
  
  // Reconstruct the clean text
  let combinedText = cleanPages.join('\n\n');
  
  // Format headings
  // Merge "Lesson\n\d+" into "Lesson \d+"
  combinedText = combinedText.replace(/Lesson\s*\n\s*(\d+)/gi, 'Lesson $1');
  
  let lines = combinedText.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for Lesson header
    if (/^Lesson\s+\d+/i.test(line)) {
      // Look for FAMILY or title in preceding lines
      let title = 'Family';
      if (i > 0 && lines[i-1].trim()) {
        title = lines[i-1].trim();
        lines[i-1] = ''; // clear it so we don't duplicate
      }
      lines[i] = `\n# Lesson 1: ${title}\n`;
    }
    
    // Check for other standard headings
    const headingPatterns = [
      /^role of family members/i,
      /^celebration of festivals/i,
      /^good practices/i,
      /^professions and occupations/i,
      /^improve your learning/i,
      /^key words/i,
      /^what we have learnt/i,
      /^activity\s*:/i
    ];
    
    for (const pattern of headingPatterns) {
      if (pattern.test(line) && line.length < 100) {
        // Strip trailing colon
        const cleanHeading = line.replace(/:\s*$/, '').trim();
        lines[i] = `\n## ${cleanHeading}\n`;
        break;
      }
    }
  }
  
  combinedText = lines.join('\n');
  
  // Merge introduction text before first heading into first heading
  const firstHeadingIdx = combinedText.indexOf('#');
  if (firstHeadingIdx > 0) {
    const introText = combinedText.substring(0, firstHeadingIdx).trim();
    const restText = combinedText.substring(firstHeadingIdx);
    
    const firstLineEnd = restText.indexOf('\n');
    if (firstLineEnd !== -1) {
      combinedText = restText.substring(0, firstLineEnd) + '\n\n' + introText + '\n' + restText.substring(firstLineEnd);
    }
  }
  
  return combinedText;
}

app.post('/books', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { title, subject, classId, teacherId } = req.body;
    let fileAssetId = null;

    if (!req.file) {
       return res.status(400).json({ error: 'No file uploaded.' });
    }

    const extname = path.extname(req.file.originalname).toLowerCase();
    if (extname !== '.docx' && extname !== '.epub' && extname !== '.pdf') {
       return res.status(400).json({ error: 'Only .docx, .epub, and .pdf files are supported for Books.' });
    }

    const storageKey = req.file.filename;
    const ownerId = toUUID(teacherId) || '20000000-0000-0000-0000-000000000002';
    const fileSql = `
      INSERT INTO file_assets (owner_id, kind, size_bytes, mime_type, storage_key, original_filename)
      VALUES ($1, 'textbook', $2, $3, $4, $5)
      RETURNING id
    `;
    const fileRes = await pool.query(fileSql, [ownerId, req.file.size, req.file.mimetype, storageKey, req.file.originalname]);
    fileAssetId = fileRes.rows[0].id;
    
    let markdown = '';
    const turndownService = new TurndownService({ headingStyle: 'atx' });

    if (extname === '.docx') {
      // Parse .docx
      const options = {
          convertImage: mammoth.images.imgElement(function(image) {
              return image.read("base64").then(function(imageBuffer) {
                  const ext = image.contentType.split('/')[1] || 'png';
                  const crypto = require('crypto');
                  const filename = crypto.randomUUID() + '.' + ext;
                  const uploadPath = path.join(uploadDir, filename);
                  fs.writeFileSync(uploadPath, Buffer.from(imageBuffer, 'base64'));
                  return { src: `/uploads/${filename}` };
              });
          })
      };
      const result = await mammoth.convertToHtml({ path: req.file.path }, options);
      markdown = turndownService.turndown(result.value);
    } else if (extname === '.epub') {
      // Parse .epub
      const { parseEpub } = require('@gxl/epub-parser');
      const epubObj = await parseEpub(req.file.path, { type: 'path' });

      // Add a custom rule to Turndown for images to write them to uploads!
      turndownService.addRule('epub-images', {
          filter: 'img',
          replacement: function(content, node) {
              const src = node.getAttribute('src');
              if (!src) return '';
              
              try {
                  if (src.indexOf('http://') === -1 && src.indexOf('https://') === -1 && !src.startsWith('data:')) {
                      const absolutePath = path.resolve('/', src).substr(1);
                      let file = null;
                      try {
                          file = epubObj.resolve(absolutePath);
                      } catch (e) {
                          try {
                              file = epubObj.resolve(src);
                          } catch (e2) {
                              const filename = path.basename(src);
                              const zipFiles = Object.keys(epubObj._zip.files);
                              const matchingKey = zipFiles.find(k => k.endsWith(filename));
                              if (matchingKey) {
                                  file = epubObj._zip.files[matchingKey];
                              }
                          }
                      }
                      
                      if (file) {
                          const buffer = file.asNodeBuffer();
                          const ext = path.extname(src).substring(1) || 'png';
                          const crypto = require('crypto');
                          const uploadName = crypto.randomUUID() + '.' + ext;
                          const uploadPath = path.join(uploadDir, uploadName);
                          fs.writeFileSync(uploadPath, buffer);
                          
                          const newSrc = `/uploads/${uploadName}`;
                          const alt = node.getAttribute('alt') || 'Image';
                          return `![${alt}](${newSrc})`;
                      }
                  }
              } catch (err) {
                  console.error('Failed to extract epub image:', src, err);
              }
              
              const alt = node.getAttribute('alt') || 'Image';
              return `![${alt}](${src})`;
          }
      });

      const mdSections = [];
      for (const section of epubObj.sections) {
          const sectionMd = turndownService.turndown(section.htmlString || '');
          if (sectionMd.trim()) {
              mdSections.push(sectionMd);
          }
      }
      markdown = mdSections.join('\n\n');
    } else if (extname === '.pdf') {
      const { PDFParse } = require('pdf-parse');
      const dataBuffer = fs.readFileSync(req.file.path);
      const parser = new PDFParse({ data: dataBuffer });
      const pdfData = await parser.getText();
      const rawText = pdfData.text || '';
      await parser.destroy();
      const textWithImages = await extractAndEmbedPdfImages(dataBuffer, rawText, uploadDir);
      markdown = optimizePdfMarkdown(textWithImages, req.file.originalname);
    }
    
    // Create Book
    const bookSql = `
      INSERT INTO books (class_id, title, subject, uploaded_by, cover_image_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const bookRes = await pool.query(bookSql, [toUUID(classId, 'class'), title, subject, ownerId, null]);
    const book = bookRes.rows[0];

      // Split by heading 1 or 2, keeping the heading using positive lookahead
      const chunks = markdown.split(/(?=\n#{1,2}\s+)/);
      // Remove any chunks that are empty
      const chapters = chunks.map(c => c.trim()).filter(c => c.length > 0);
      
      let chapterNumber = 1;
      for (let i = 0; i < chapters.length; i++) {
          let chapterContent = chapters[i];
          let chapterTitle = `Chapter ${chapterNumber}`;
          
          if (i === 0 && !chapterContent.startsWith('#')) {
              chapterTitle = "Introduction";
          } else {
              // Extract the heading title
              const lines = chapterContent.split('\n');
              const headingLine = lines[0].trim();
              // Strip '#' characters, and if it's an image link like ![](), replace with "Chapter X"
              let extractedTitle = headingLine.replace(/^#+\s*/, '').trim();
              if (extractedTitle.startsWith('![')) {
                  extractedTitle = `Chapter ${chapterNumber}`;
              }
              chapterTitle = extractedTitle || `Chapter ${chapterNumber}`;
          }
          
          const smSql = `
            INSERT INTO study_materials (class_id, title, subject, body, uploaded_by, book_id, chapter_number)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `;
          await pool.query(smSql, [toUUID(classId, 'class'), chapterTitle, subject, chapterContent, ownerId, book.id, chapterNumber]);
          chapterNumber++;
      }

    res.status(201).json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/books', authenticateToken, async (req, res) => {
  try {
    let sql = `SELECT * FROM books`;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/books/:id/chapters', authenticateToken, async (req, res) => {
  try {
    let sql = `SELECT * FROM study_materials WHERE book_id = $1 ORDER BY chapter_number ASC`;
    const { rows } = await pool.query(sql, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Progress Reports
app.get('/progress', authenticateToken, async (req, res) => {
  try {
    let sql = 'SELECT * FROM progress_reports';
    let params = [];
    if (req.query.studentId) {
      sql = `
        SELECT pr.*, s.name as subject_name
        FROM progress_reports pr
        LEFT JOIN subjects s ON pr.subject_id = s.id
        WHERE pr.student_id = $1
      `;
      params.push(toUUID(req.query.studentId));
    }
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(row => ({
      subject: row.subject_name || 'Science',
      grade: row.grade,
      percentage: parseInt(row.percentage, 10),
      teacherNote: row.teacher_note,
      downloadsCount: parseInt(row.downloads_count, 10) || 0,
      assignmentsCompleted: parseInt(row.assignments_completed, 10) || 0,
      examPerformance: parseFloat(row.exam_performance) || 0
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calendar
app.get('/calendar', authenticateToken, async (req, res) => {
  try {
    let sql1 = `
      SELECT a.id, a.title, a.instructions as description, a.due_at as date, 'assignment' as type
      FROM assignments a
      JOIN class_students cs ON a.class_id = cs.class_id
      WHERE cs.student_id = $1
    `;
    let sql2 = `
      SELECT e.id, e.title, e.description, e.scheduled_at as date, 'exam' as type
      FROM exams e
      JOIN class_students cs ON e.class_id = cs.class_id
      WHERE cs.student_id = $1
    `;
    const studentId = toUUID(req.query.studentId || '1');
    const { rows: assignments } = await pool.query(sql1, [studentId]);
    const { rows: exams } = await pool.query(sql2, [studentId]);

    const items = [...assignments, ...exams];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const formatted = items.map((item, idx) => {
      const d = new Date(item.date);
      return {
        id: String(idx + 1),
        month: months[d.getMonth()],
        day: String(d.getDate()),
        title: item.title,
        description: item.description || '',
        colorClass: item.type === 'exam' ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'
      };
    });

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Messages
app.get('/messages', authenticateToken, async (req, res) => {
  try {
    const studentId = toUUID(req.query.studentId);
    let sql = 'SELECT * FROM messages';
    let params = [];
    if (studentId) {
      sql = 'SELECT * FROM messages WHERE student_id = $1 ORDER BY sent_at ASC';
      params.push(studentId);
    }
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(m => ({
      id: toShortID(m.id),
      senderId: toShortID(m.sender_id),
      recipientId: toShortID(m.recipient_id),
      studentId: toShortID(m.student_id),
      body: m.body,
      sentAt: m.sent_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/messages', authenticateToken, async (req, res) => {
  try {
    const { senderId, recipientId, studentId, body } = req.body;
    const sql = `
      INSERT INTO messages (sender_id, recipient_id, student_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [toUUID(senderId), toUUID(recipientId), toUUID(studentId), body]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Admin Statistics
app.get('/adminStats', authenticateToken, async (req, res) => {
  try {
    const { rows: users } = await pool.query('SELECT count(*) FROM users');
    const totalUsers = users[0].count;
    res.json([
      { id: '1', title: 'Total Users', value: totalUsers.toString(), iconName: 'Users', colorClass: 'text-indigo-500' },
      { id: '2', title: 'Active Sessions', value: '1', iconName: 'Activity', colorClass: 'text-green-500' },
      { id: '3', title: 'Compliance Score', value: '100%', iconName: 'Shield', colorClass: 'text-blue-500' },
      { id: '4', title: 'System Errors', value: '0', iconName: 'Settings', colorClass: 'text-gray-500' }
    ]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/recentUsers', authenticateToken, async (req, res) => {
  try {
    const sql = `
      SELECT u.first_name, u.last_name, u.email, u.role, sp.accessibility_profile as needs, u.created_at
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      ORDER BY u.created_at DESC LIMIT 5
    `;
    const { rows } = await pool.query(sql);
    res.json(rows.map(row => ({
      name: `${row.first_name} ${row.last_name}`,
      email: row.email,
      role: row.role,
      needs: row.needs || 'typical',
      date: new Date(row.created_at).toLocaleDateString()
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teacher Statistics
app.get('/teacherStats', authenticateToken, async (req, res) => {
  try {
    const teacherId = toUUID(req.query.teacherId);
    if (!teacherId) return res.status(400).json({ error: 'Missing teacherId' });

    // Total Students
    const studentCountRes = await pool.query(`
      SELECT COUNT(DISTINCT cs.student_id) as count
      FROM classes c
      JOIN class_students cs ON c.id = cs.class_id
      WHERE c.teacher_id = $1
    `, [teacherId]);
    const totalStudents = studentCountRes.rows[0].count;

    // Active Classes
    const classCountRes = await pool.query('SELECT COUNT(*) as count FROM classes WHERE teacher_id = $1', [teacherId]);
    const totalClasses = classCountRes.rows[0].count;

    // Assignments to Grade
    const gradeRes = await pool.query(`
      SELECT COUNT(*) as count
      FROM assignments a
      JOIN assignment_submissions s ON a.id = s.assignment_id
      JOIN classes c ON a.class_id = c.id
      WHERE c.teacher_id = $1 AND s.status = 'Submitted'
    `, [teacherId]);
    const toGrade = gradeRes.rows[0].count;

    res.json([
      { id: '1', title: 'Total Students', value: totalStudents.toString(), iconName: 'Users', colorClass: 'text-indigo-500' },
      { id: '2', title: 'Active Classes', value: totalClasses.toString(), iconName: 'Monitor', colorClass: 'text-green-500' },
      { id: '3', title: 'Assignments to Grade', value: toGrade.toString(), iconName: 'BarChart', colorClass: 'text-orange-500' },
      { id: '4', title: 'Accessibility Alerts', value: '0', iconName: 'ShieldAlert', colorClass: 'text-red-500' }
    ]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/accessibilityBreakdown', authenticateToken, async (req, res) => {
  try {
    const teacherId = toUUID(req.query.teacherId);
    if (!teacherId) return res.status(400).json({ error: 'Missing teacherId' });

    const sql = `
      SELECT sp.accessibility_profile, COUNT(DISTINCT cs.student_id) as count
      FROM classes c
      JOIN class_students cs ON c.id = cs.class_id
      JOIN student_profiles sp ON cs.student_id = sp.user_id
      WHERE c.teacher_id = $1
      GROUP BY sp.accessibility_profile
    `;
    const { rows } = await pool.query(sql, [teacherId]);
    
    let total = 0;
    rows.forEach(r => total += parseInt(r.count, 10));

    res.json(rows.map((r, idx) => ({
      id: String(idx + 1),
      profile: r.accessibility_profile ? (r.accessibility_profile.charAt(0).toUpperCase() + r.accessibility_profile.slice(1)) : 'Typical',
      count: parseInt(r.count, 10),
      percentage: total > 0 ? Math.round((parseInt(r.count, 10) / total) * 100) + '%' : '0%'
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attendance
app.post('/attendance', authenticateToken, async (req, res) => {
  // Mock endpoint since we don't have an attendance table yet
  res.status(201).json(req.body);
});

// Delete User
app.delete('/users/:id', authenticateToken, async (req, res) => {
  try {
    const userId = toUUID(req.params.id);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Link Student to Parent
app.post('/users/:id/students', authenticateToken, async (req, res) => {
  try {
    const parentId = toUUID(req.params.id);
    const studentId = toUUID(req.body.studentId);
    const relationship = req.body.relationship || 'Parent';
    
    await pool.query(
      'INSERT INTO parent_student_links (parent_id, student_id, relationship) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [parentId, studentId, relationship]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unlink Student from Parent
app.delete('/users/:id/students/:studentId', authenticateToken, async (req, res) => {
  try {
    const parentId = toUUID(req.params.id);
    const studentId = toUUID(req.params.studentId);
    await pool.query(
      'DELETE FROM parent_student_links WHERE parent_id = $1 AND student_id = $2',
      [parentId, studentId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Linked Students for Parent
app.get('/parents/:id/students', authenticateToken, async (req, res) => {
  try {
    const parentId = toUUID(req.params.id);
    const sql = `
      SELECT u.id, u.username, u.first_name, u.last_name, u.email, u.role, u.grade_level
      FROM users u
      JOIN parent_student_links psl ON u.id = psl.student_id
      WHERE psl.parent_id = $1
    `;
    const result = await pool.query(sql, [parentId]);
    res.json(result.rows.map(row => ({
      id: toShortID(row.id),
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      role: row.role,
      gradeLevel: row.grade_level
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/students/:id/progress', authenticateToken, async (req, res) => {
  try {
    const studentId = toUUID(req.params.id);
    const sql = `
      SELECT pr.*, s.name as subject_name,
             (SELECT COALESCE(SUM(time_spent_seconds), 0) FROM lesson_activity WHERE student_id = $1 AND lesson_id IN (SELECT id FROM lessons WHERE subject_id = s.id)) as time_spent
      FROM progress_reports pr
      JOIN subjects s ON pr.subject_id = s.id
      WHERE pr.student_id = $1
    `;
    const result = await pool.query(sql, [studentId]);
    res.json(result.rows.map(row => ({
      subject: row.subject_name || 'Science',
      grade: row.grade || 'A',
      progress: parseInt(row.percentage, 10) || 0,
      status: row.percentage >= 80 ? 'Excellent' : row.percentage >= 50 ? 'Good' : 'Needs Attention',
      downloads: parseInt(row.downloads_count, 10) || 0,
      timeSpent: parseInt(row.time_spent, 10) || 0,
      assignmentsCompleted: parseInt(row.assignments_completed, 10) || 0,
      examPerformance: parseFloat(row.exam_performance) || 0,
      lastActive: new Date().toISOString()
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback handlers to satisfy JSON Server routing for static tables
app.get('/subjects', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM subjects');
    res.json(rows.map(s => ({
      id: toShortID(s.id),
      name: s.name,
      gradeBand: s.grade_band,
      description: s.description
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listen on server start
app.listen(PORT, () => {
  console.log(`LAAMS API Gateway Service running on http://localhost:${PORT}`);
});
