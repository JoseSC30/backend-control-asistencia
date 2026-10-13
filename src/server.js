import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { pool, query } from './db.js';
import { authenticate, requireAdmin } from './middleware.js';

dotenv.config();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());

async function activeModule() {
  const { rows } = await query("SELECT * FROM modules WHERE status = 'ACTIVE' LIMIT 1");
  return rows[0];
}
async function logActivity(userId, moduleId, action, entityType, entityId, details = {}) {
  await query('INSERT INTO activity_logs (user_id,module_id,action,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6)', [userId, moduleId, action, entityType, entityId, details]);
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
    const { rows } = await query("SELECT u.*, s.registration_number FROM app_users u LEFT JOIN students s ON s.id=u.student_id LEFT JOIN modules m ON m.id=s.module_id AND m.status='ACTIVE' WHERE u.email=$1 AND u.role='ADMIN' OR (s.registration_number=$1 AND m.id IS NOT NULL) OR (u.email=$1 AND m.id IS NOT NULL)", [identifier]);
    const user = rows[0];
    const validPassword = user?.role === 'STUDENT'
      ? true
      : user && await bcrypt.compare(password || '', user.password_hash);
    if (!user || !validPassword) return res.status(401).json({ message: 'Credenciales incorrectas.' });
    const token = jwt.sign({ id: user.id, role: user.role, studentId: user.student_id, name: user.full_name }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, name: user.full_name, role: user.role, registrationNumber: user.registration_number } });
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
    const { rows } = await query('SELECT id,registration_number,full_name,email FROM students WHERE module_id=$1 AND (full_name ILIKE $2 OR registration_number ILIKE $2) ORDER BY full_name', [module.id, search]);
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
    const { rows } = await query(`SELECT cd.id class_date_id,cd.class_date::text AS class_date,cd.start_time::text AS start_time,cd.end_time::text AS end_time,s.id student_id,s.registration_number,s.full_name,CASE WHEN a.status IS NOT NULL THEN a.status WHEN cd.class_date < CURRENT_DATE THEN 'ABSENT' ELSE 'PENDING' END status,a.marked_at FROM class_dates cd CROSS JOIN students s LEFT JOIN attendances a ON a.class_date_id=cd.id AND a.student_id=s.id WHERE cd.module_id=$1 AND s.module_id=$1 ${filter} ORDER BY cd.class_date,s.full_name`, params);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/attendance', authenticate, async (req, res, next) => {
  try {
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    if (req.user.role !== 'STUDENT') return res.status(403).json({ message: 'Solo un estudiante puede marcar su asistencia.' });
    const { rows } = await query('SELECT * FROM class_dates WHERE id=$1 AND module_id=$2 AND class_date=CURRENT_DATE', [req.body.classDateId, module.id]);
    if (!rows[0]) return res.status(400).json({ message: 'La asistencia solo puede marcarse durante una fecha de clase habilitada.' });
    await query(`INSERT INTO attendances (module_id,student_id,class_date_id,status,marked_at,marked_by) VALUES ($1,$2,$3,'PRESENT',now(),$4) ON CONFLICT (student_id,class_date_id) DO UPDATE SET status='PRESENT',marked_at=EXCLUDED.marked_at,marked_by=EXCLUDED.marked_by,updated_at=now()`, [module.id, req.user.studentId, req.body.classDateId, req.user.id]);
    await logActivity(req.user.id, module.id, 'MARK_ATTENDANCE', 'attendance', req.body.classDateId);
    res.status(201).json({ message: 'Asistencia registrada.' });
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
    if (!['PRESENT', 'ABSENT'].includes(status)) return res.status(400).json({ message: 'Estado de asistencia inválido.' });
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
         SET status=$1::varchar, marked_at=CASE WHEN $1::varchar='PRESENT' THEN now() ELSE NULL END,
             marked_by=$2, updated_at=now()
         WHERE student_id=$3 AND class_date_id=$4`,
        [status, req.user.id, studentId, classDateId],
      );
      if (updated.rowCount === 0) {
        await client.query(
          `INSERT INTO attendances
             (module_id,student_id,class_date_id,status,marked_at,marked_by)
           VALUES ($1,$2,$3,$4::varchar,CASE WHEN $4::varchar='PRESENT' THEN now() ELSE NULL END,$5)`,
          [module.id, studentId, classDateId, status, req.user.id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await logActivity(req.user.id, module.id, 'UPDATE_ATTENDANCE', 'attendance', classDateId, { studentId, previous: previousStatus, next: status });
    res.json({ message: 'Asistencia actualizada.' });
  } catch (error) { next(error); }
});

app.post('/api/import/students', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Debe adjuntar un archivo Excel.' });
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const workbook = XLSX.read(req.file.buffer); const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    const errors = []; let imported = 0;
    for (const [index, row] of rows.entries()) {
      const registrationNumber = String(row['Número de registro'] || row.registration_number || '').trim();
      const fullName = String(row['Nombre completo'] || row.full_name || '').trim();
      const email = String(row['Correo electrónico'] || row.email || '').trim();
      if (!registrationNumber || !fullName || !email) { errors.push(`Fila ${index + 2}: faltan campos obligatorios.`); continue; }
      try {
        const { rows: studentRows } = await query('INSERT INTO students(module_id,registration_number,full_name,email) VALUES($1,$2,$3,$4) RETURNING id', [module.id, registrationNumber, fullName, email]);
        await query('INSERT INTO app_users(email,password_hash,full_name,role,student_id) VALUES($1,$2,$3,\'STUDENT\',$4) ON CONFLICT (email) DO UPDATE SET student_id=EXCLUDED.student_id', [email, await bcrypt.hash(registrationNumber, 10), fullName, studentRows[0].id]);
        imported++;
      } catch { errors.push(`Fila ${index + 2}: registro o correo duplicado.`); }
    }
    res.json({ imported, errors });
  } catch (error) { next(error); }
});

app.post('/api/import/class-dates', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Debe adjuntar un archivo Excel.' });
    const module = await activeModule();
    if (!module) return res.status(409).json({ message: 'No existe un módulo activo.' });
    const workbook = XLSX.read(req.file.buffer, { cellDates: true }); const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    const errors = []; let imported = 0;
    for (const [index, row] of rows.entries()) {
      const date = excelDate(row.Fecha || row.date);
      const start = excelTime(row['Hora inicio'] || row.start_time); const end = excelTime(row['Hora fin'] || row.end_time);
      if (!date || !start || !end) { errors.push(`Fila ${index + 2}: faltan campos obligatorios.`); continue; }
      try {
        await query('INSERT INTO class_dates(module_id,class_date,start_time,end_time) VALUES($1,$2,$3,$4)', [module.id, date, start, end]);
        imported++;
      } catch (error) {
        const reason = error.code === '23505' ? 'fecha duplicada' : error.code === '23514' ? 'la hora fin debe ser posterior a la hora inicio' : 'formato inválido';
        errors.push(`Fila ${index + 2}: ${reason}.`);
      }
    }
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
    await client.query('COMMIT');
    await logActivity(req.user.id, rows[0].id, 'ACTIVATE_MODULE', 'module', rows[0].id);
    res.status(201).json({ module: rows[0] });
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

app.get('/api/activity-logs', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const module = await activeModule();
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
