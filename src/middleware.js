import jwt from 'jsonwebtoken';

export function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Autenticación requerida.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Sesión inválida o expirada.' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ message: 'Solo el administrador puede realizar esta acción.' });
  next();
}
