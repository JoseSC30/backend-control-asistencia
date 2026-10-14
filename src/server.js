import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { pool, query } from './db.js';
import { authenticate, requireAdmin } from './middleware.js';

dotenv.config();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());

const LATE_TOLERANCE_MINUTES = 15;
const MAX_IMPORT_ROWS = 2000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fileExtension(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}
function readSheetRows(file) {
  try {
    const workbook = XLSX.read(file.buffer, { cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return null;
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch {
    return null;
  }
}
function missingHeaders(headers, required) {
  return required
    .filter(({ aliases }) => !aliases.some(alias => headers.includes(alias)))
    .map(({ label }) => label);
}

async function activeModule() {
  const { rows } = await query("SELECT * FROM modules WHERE status = 'ACTIVE' LIMIT 1");
  return rows[0];
}
async function logActivity(userId, moduleId, action, entityType, entityId, details = {}, client = null) {
  const sql = 'INSERT INTO activity_logs (user_id,module_id,action,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6)';
  const params = [userId, moduleId, action, entityType, entityId, details];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}
function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}
function excelTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const totalSeconds = Math.round(value * 24 * 60 * 60);
    const hours = Math.floor(totalSeconds / 3600) % 24;
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] || 0) < 60) {
    return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
  }
  return '';
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier) return res.status(400).json({ message: 'Debes indicar tu correo o número de registro.' });
    const { rows } = await query(
      `SELECT u.*, s.registration_number
         FROM app_users u
         LEFT JOIN students s ON s.id = u.student_id
         LEFT JOIN modules m ON m.id = s.module_id AND m.status = 'ACTIVE'
        WHERE (u.role = 'ADMIN' AND u.email = $1)
           OR (u.role = 'STUDENT' AND m.id IS NOT NULL AND (s.registration_number = $1 OR u.email = $1))
        ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END
        LIMIT 1`,
      [identifier],
    );
    const user = rows[0];
    const validPassword = user?.role === 'STUDENT'
      ? true
      : user && await bcrypt.compare(password || '', user.password_hash);
    if (!user || !validPassword) return res.status(401).json({ message: 'Credenciales incorrectas.' });
    const token = jwt.sign({ id: user.id, role: user.role, studentId: user.student_id, name: user.full_name }, process.env.JWT_SECRET, { expiresIn: '8h', jwtid: randomUUID() });
    res.json({ token, user: { id: user.id, name: user.full_name, role: user.role, registrationNumber: user.registration_number } });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', authenticate, async (req, res, next) => {
  try {
    if (req.user.jti && req.user.exp) {
      await query('INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT (jti) DO NOTHING', [req.user.jti, req.user.exp]);
    }
    await query('DELETE FROM revoked_tokens WHERE expires_at < now()');
    res.json({ message: 'Sesión cerrada.' });
  } catch (error) { next(error); }
});

app.get('/api/me', authenticate, async (req, res, next) => {
  try {
    const module = await activeModule();
    res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role, studentId: req.user.studentId }, module: module || null });
  } catch (error) { next(error); }
});

app.get('/api/modules/active', authenticate, async (_req, res, next) => {
  try { res.json({ module: await activeModule() }); } catch (error) { next(error); }
});

app.get('/api/students', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const search = `%${req.query.search || ''}%`;
    const { rows } = await query('SELECT id,registration_number,full_name,email FROM students WHERE module_id=$1 AND (unaccent(full_name) ILIKE unaccent($2::text) OR unaccent(registration_number) ILIKE unaccent($2::text)) ORDER BY full_name', [module.id, search]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get('/api/class-dates', authenticate, async (_req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const { rows } = await query('SELECT id,module_id,class_date::text AS class_date,start_time::text AS start_time,end_time::text AS end_time FROM class_dates WHERE module_id=$1 ORDER BY class_date', [module.id]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get('/api/attendance', authenticate, async (req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const studentId = req.user.role === 'STUDENT' ? req.user.studentId : req.query.studentId;
    const params = [module.id]; let filter = '';
    if (studentId) { params.push(studentId); filter += ` AND s.id=$${params.length}`; }
    if (req.query.date) { params.push(req.query.date); filter += ` AND cd.class_date=$${params.length}`; }
    if (req.query.search) { params.push(`%${req.query.search}%`); const ph = '\x24' + params.length; filter += ` AND (unaccent(s.full_name) ILIKE unaccent(${ph}::text) OR unaccent(s.registration_number) ILIKE unaccent(${ph}::text))`; }
    const { rows } = await query(`SELECT cd.id class_date_id,cd.class_date::text AS class_date,cd.start_time::text AS start_time,cd.end_time::text AS end_time,s.id student_id,s.registration_number,s.full_name,CASE WHEN a.status IS NOT NULL THEN a.status WHEN cd.class_date < CURRENT_DATE THEN 'ABSENT' ELSE 'PENDING' END status,a.marked_at FROM class_dates cd CROSS JOIN students s LEFT JOIN attendances a ON a.class_date_id=cd.id AND a.student_id=s.id WHERE cd.module_id=$1 AND s.module_id=$1 ${filter} ORDER BY cd.class_date,s.full_name`, params);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get('/api/attendance/summary', authenticate, async (req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const studentId = req.user.role === 'STUDENT' ? req.user.studentId : req.query.studentId;
    const params = [module.id]; let filter = '';
    if (studentId) { params.push(studentId); filter += ` AND s.id=$${params.length}`; }
    if (req.query.date) { params.push(req.query.date); filter += ` AND cd.class_date=$${params.length}`; }
    if (req.query.search) { params.push(`%${req.query.search}%`); const ph = '\x24' + params.length; filter += ` AND (unaccent(s.full_name) ILIKE unaccent(${ph}::text) OR unaccent(s.registration_number) ILIKE unaccent(${ph}::text))`; }
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE status='PRESENT')::int present,
              COUNT(*) FILTER (WHERE status='LATE')::int late,
              COUNT(*) FILTER (WHERE status='ABSENT')::int absent,
              COUNT(*) FILTER (WHERE status='PENDING')::int pending,
              COUNT(*)::int total
         FROM (
           SELECT CASE WHEN a.status IS NOT NULL THEN a.status
                       WHEN cd.class_date < CURRENT_DATE THEN 'ABSENT'
                       ELSE 'PENDING' END status
             FROM class_dates cd
             JOIN students s ON s.module_id = cd.module_id
             LEFT JOIN attendances a ON a.class_date_id = cd.id AND a.student_id = s.id
            WHERE cd.module_id = $1 ${filter}
         ) t`,
      params,
    );
    const summary = rows[0];
    const evaluable = summary.present + summary.late + summary.absent;
    const attendanceRate = evaluable ? Math.round(((summary.present + summary.late) / evaluable) * 100) : 0;
    res.json({ ...summary, evaluable, attendanceRate });
  } catch (error) { next(error); }
});

app.post('/api/attendance', authenticate, async (req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    if (req.user.role !== 'STUDENT') return res.status(403).json({ message: 'Solo un estudiante puede marcar su asistencia.' });
    const student = await query('SELECT id FROM students WHERE id=$1 AND module_id=$2', [req.user.studentId, module.id]);
    if (!student.rows[0]) return res.status(403).json({ message: 'El estudiante no pertenece al módulo activo.' });

    const { rows: classRows } = await query(
      `SELECT id,
              (LOCALTIME < start_time OR LOCALTIME > end_time) AS outside_window,
              (LOCALTIME > start_time + ($3::text || ' minutes')::interval) AS is_late
         FROM class_dates
        WHERE id=$1 AND module_id=$2 AND class_date=CURRENT_DATE`,
      [req.body.classDateId, module.id, LATE_TOLERANCE_MINUTES],
    );
    const classDate = classRows[0];
    if (!classDate) return res.status(400).json({ message: 'La asistencia solo puede marcarse durante una fecha de clase habilitada.' });
    if (classDate.outside_window) return res.status(400).json({ message: 'Solo puedes marcar tu asistencia entre la hora de inicio y fin de la clase.' });
    const status = classDate.is_late ? 'LATE' : 'PRESENT';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO attendances (module_id,student_id,class_date_id,status,marked_at,marked_by)
         VALUES ($1,$2,$3,$4,now(),$5)
         ON CONFLICT (student_id,class_date_id) DO NOTHING
         RETURNING id`,
        [module.id, req.user.studentId, req.body.classDateId, status, req.user.id],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'ATTENDANCE_ALREADY_MARKED', message: 'La asistencia ya fue registrada.' });
      }
      await logActivity(req.user.id, module.id, 'MARK_ATTENDANCE', 'attendance', req.body.classDateId, { studentId: req.user.studentId, status }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    res.status(201).json({ message: status === 'LATE' ? 'Asistencia registrada con retraso.' : 'Asistencia registrada.', status });
  } catch (error) { next(error); }
});

app.patch('/api/attendance/:studentId/:classDateId', authenticate, requireAdmin, async (req, res, next) => {
  const studentId = Number(req.params.studentId);
  const classDateId = Number(req.params.classDateId);
  if (!Number.isInteger(studentId) || !Number.isInteger(classDateId)) {
    return res.status(400).json({ message: 'Identificador de estudiante o fecha inválido.' });
  }
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const status = req.body.status;
    if (!['PRESENT', 'LATE', 'ABSENT'].includes(status)) return res.status(400).json({ message: 'Estado de asistencia inválido.' });
    const client = await pool.connect();
    let previousStatus = 'ABSENT';
    try {
      await client.query('BEGIN');
      const { rows: target } = await client.query(
        'SELECT s.id FROM students s JOIN class_dates cd ON cd.module_id=s.module_id WHERE s.id=$1 AND cd.id=$2 AND s.module_id=$3',
        [studentId, classDateId, module.id],
      );
      if (!target[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'El estudiante o la fecha no pertenece al módulo activo.' });
      }
      const { rows: previous } = await client.query(
        'SELECT status FROM attendances WHERE student_id=$1 AND class_date_id=$2',
        [studentId, classDateId],
      );
      previousStatus = previous[0]?.status || 'ABSENT';
      const updated = await client.query(
        `UPDATE attendances
         SET status=$1::varchar, marked_at=CASE WHEN $1::varchar IN ('PRESENT','LATE') THEN now() ELSE NULL END,
             marked_by=$2, updated_at=now()
         WHERE student_id=$3 AND class_date_id=$4`,
        [status, req.user.id, studentId, classDateId],
      );
      if (updated.rowCount === 0) {
        await client.query(
          `INSERT INTO attendances
             (module_id,student_id,class_date_id,status,marked_at,marked_by)
           VALUES ($1,$2,$3,$4::varchar,CASE WHEN $4::varchar IN ('PRESENT','LATE') THEN now() ELSE NULL END,$5)`,
          [module.id, studentId, classDateId, status, req.user.id],
        );
      }
      await logActivity(req.user.id, module.id, 'UPDATE_ATTENDANCE', 'attendance', classDateId, { studentId, previous: previousStatus, next: status }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    res.json({ message: 'Asistencia actualizada.' });
  } catch (error) { next(error); }
});

app.post('/api/import/students', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Debe adjuntar un archivo Excel.' });
    if (!['xlsx', 'xls'].includes(fileExtension(req.file.originalname))) {
      return res.status(400).json({ message: 'Formato no admitido. Usa un archivo .xlsx o .xls.' });
    }
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const rows = readSheetRows(req.file);
    if (!rows) return res.status(400).json({ message: 'El archivo no es un Excel válido o está dañado.' });
    if (!rows.length) return res.status(400).json({ message: 'El archivo no contiene filas de datos.' });
    if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ message: `El archivo supera el máximo de ${MAX_IMPORT_ROWS} filas.` });
    const missing = missingHeaders(Object.keys(rows[0]), [
      { label: 'Número de registro', aliases: ['Número de registro', 'registration_number'] },
      { label: 'Nombre completo', aliases: ['Nombre completo', 'full_name'] },
      { label: 'Correo electrónico', aliases: ['Correo electrónico', 'email'] },
    ]);
    if (missing.length) return res.status(400).json({ message: `Faltan columnas obligatorias: ${missing.join(', ')}.` });

    const errors = []; let imported = 0;
    const client = await pool.connect();
    try {
      for (const [index, row] of rows.entries()) {
        const registrationNumber = String(row['Número de registro'] || row.registration_number || '').trim();
        const fullName = String(row['Nombre completo'] || row.full_name || '').trim();
        const email = String(row['Correo electrónico'] || row.email || '').trim();
        if (!registrationNumber || !fullName || !email) { errors.push(`Fila ${index + 2}: faltan campos obligatorios.`); continue; }
        if (!EMAIL_PATTERN.test(email)) { errors.push(`Fila ${index + 2}: el correo no tiene un formato válido.`); continue; }
        try {
          await client.query('BEGIN');
          const { rows: studentRows } = await client.query('INSERT INTO students(module_id,registration_number,full_name,email) VALUES($1,$2,$3,$4) RETURNING id', [module.id, registrationNumber, fullName, email]);
          await client.query('INSERT INTO app_users(email,password_hash,full_name,role,student_id,module_id) VALUES($1,$2,$3,\'STUDENT\',$4,$5)', [email, await bcrypt.hash(registrationNumber, 10), fullName, studentRows[0].id, module.id]);
          await client.query('COMMIT');
          imported++;
        } catch (error) {
          await client.query('ROLLBACK');
          const reason = error.code === '23505' ? 'registro o correo duplicado' : 'datos inválidos';
          errors.push(`Fila ${index + 2}: ${reason}.`);
        }
      }
    } finally {
      client.release();
    }
    await logActivity(req.user.id, module.id, 'IMPORT_STUDENTS', 'module', module.id, { imported, errors: errors.length });
    res.json({ imported, errors });
  } catch (error) { next(error); }
});

app.post('/api/import/class-dates', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Debe adjuntar un archivo Excel.' });
    if (!['xlsx', 'xls'].includes(fileExtension(req.file.originalname))) {
      return res.status(400).json({ message: 'Formato no admitido. Usa un archivo .xlsx o .xls.' });
    }
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const rows = readSheetRows(req.file);
    if (!rows) return res.status(400).json({ message: 'El archivo no es un Excel válido o está dañado.' });
    if (!rows.length) return res.status(400).json({ message: 'El archivo no contiene filas de datos.' });
    if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ message: `El archivo supera el máximo de ${MAX_IMPORT_ROWS} filas.` });
    const missing = missingHeaders(Object.keys(rows[0]), [
      { label: 'Fecha', aliases: ['Fecha', 'date'] },
      { label: 'Hora inicio', aliases: ['Hora inicio', 'start_time'] },
      { label: 'Hora fin', aliases: ['Hora fin', 'end_time'] },
    ]);
    if (missing.length) return res.status(400).json({ message: `Faltan columnas obligatorias: ${missing.join(', ')}.` });

    const errors = []; let imported = 0;
    for (const [index, row] of rows.entries()) {
      const date = excelDate(row.Fecha || row.date);
      const start = excelTime(row['Hora inicio'] || row.start_time); const end = excelTime(row['Hora fin'] || row.end_time);
      if (!date || !start || !end) { errors.push(`Fila ${index + 2}: faltan campos obligatorios o formato inválido.`); continue; }
      try {
        await query('INSERT INTO class_dates(module_id,class_date,start_time,end_time) VALUES($1,$2,$3,$4)', [module.id, date, start, end]);
        imported++;
      } catch (error) {
        const reason = error.code === '23505' ? 'fecha duplicada' : error.code === '23514' ? 'la hora fin debe ser posterior a la hora inicio' : 'formato inválido';
        errors.push(`Fila ${index + 2}: ${reason}.`);
      }
    }
    await logActivity(req.user.id, module.id, 'IMPORT_CLASS_DATES', 'module', module.id, { imported, errors: errors.length });
    res.json({ imported, errors });
  } catch (error) { next(error); }
});

app.post('/api/modules/activate', authenticate, requireAdmin, async (req, res, next) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: 'El nombre del módulo es obligatorio.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE modules SET status='ARCHIVED' WHERE status='ACTIVE'");
    const { rows } = await client.query("INSERT INTO modules(name,status,activated_at) VALUES($1,'ACTIVE',now()) RETURNING *", [name.trim()]);
    await logActivity(req.user.id, rows[0].id, 'ACTIVATE_MODULE', 'module', rows[0].id, { name: rows[0].name }, client);
    await client.query('COMMIT');
    res.status(201).json({ module: rows[0] });
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

app.get('/api/activity-logs', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const params = [module.id]; let filter = '';
    if (req.query.date) { params.push(req.query.date); filter += ` AND l.created_at::date=$${params.length}`; }
    if (req.query.studentId) { params.push(req.query.studentId); filter += ` AND (l.details->>'studentId')::bigint=$${params.length}`; }
    const { rows } = await query(`SELECT l.*,u.full_name user_name FROM activity_logs l LEFT JOIN app_users u ON u.id=l.user_id WHERE l.module_id=$1 ${filter} ORDER BY l.created_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error('API error:', error);
  res.status(500).json({ message: 'Error interno del servidor.' });
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API disponible en http://localhost:${port}`));
