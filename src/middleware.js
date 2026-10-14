import jwt from 'jsonwebtoken';
import { query } from './db.js';

export async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Autenticación requerida.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.jti) {
      const { rows } = await query('SELECT 1 FROM revoked_tokens WHERE jti = $1 AND expires_at > now() LIMIT 1', [payload.jti]);
      if (rows[0]) return res.status(401).json({ message: 'La sesión fue cerrada. Inicia sesión de nuevo.' });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Sesión inválida o expirada.' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ message: 'Solo el administrador puede realizar esta acción.' });
  next();
}
