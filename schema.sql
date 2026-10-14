-- Sistema Web de Registro y Control de Asistencia
-- PostgreSQL 14+

CREATE DATABASE control_asistencia;
\connect control_asistencia;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  email CITEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'STUDENT')),
  student_id BIGINT UNIQUE,
  module_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modules (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ARCHIVED' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_module
  ON modules (status) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  module_id BIGINT NOT NULL REFERENCES modules(id),
  registration_number VARCHAR(30) NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  email CITEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, registration_number),
  UNIQUE (module_id, email)
);

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_student_id_fkey;
ALTER TABLE app_users
  ADD CONSTRAINT app_users_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;

-- Identidad: el correo de los estudiantes es único por módulo; el de los
-- administradores sigue siendo único global. Se reemplaza la restricción
-- global antigua por índices únicos parciales.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS module_id BIGINT;
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_email_key;
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_module_id_fkey;
ALTER TABLE app_users
  ADD CONSTRAINT app_users_module_id_fkey
  FOREIGN KEY (module_id) REFERENCES modules(id);
UPDATE app_users u SET module_id = s.module_id
  FROM students s
 WHERE u.student_id = s.id AND u.role = 'STUDENT'
   AND u.module_id IS DISTINCT FROM s.module_id;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_admin_email
  ON app_users(email) WHERE role = 'ADMIN';
CREATE UNIQUE INDEX IF NOT EXISTS app_users_student_email
  ON app_users(module_id, email) WHERE role = 'STUDENT';

CREATE TABLE IF NOT EXISTS class_dates (
  id BIGSERIAL PRIMARY KEY,
  module_id BIGINT NOT NULL REFERENCES modules(id),
  class_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE (module_id, class_date),
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS attendances (
  id BIGSERIAL PRIMARY KEY,
  module_id BIGINT NOT NULL REFERENCES modules(id),
  student_id BIGINT NOT NULL REFERENCES students(id),
  class_date_id BIGINT NOT NULL REFERENCES class_dates(id),
  status VARCHAR(20) NOT NULL CHECK (status IN ('PRESENT', 'LATE', 'ABSENT')),
  marked_at TIMESTAMPTZ,
  marked_by BIGINT REFERENCES app_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, class_date_id)
);

-- Bases de datos existentes: habilitar el estado LATE (retraso).
ALTER TABLE attendances DROP CONSTRAINT IF EXISTS attendances_status_check;
ALTER TABLE attendances ADD CONSTRAINT attendances_status_check
  CHECK (status IN ('PRESENT', 'LATE', 'ABSENT'));

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY KEY,
  module_id BIGINT REFERENCES modules(id),
  user_id BIGINT REFERENCES app_users(id),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(50),
  entity_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tokens invalidados al cerrar sesión (logout).
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti UUID PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_students_module_name ON students(module_id, full_name);
CREATE INDEX IF NOT EXISTS idx_class_dates_module_date ON class_dates(module_id, class_date);
CREATE INDEX IF NOT EXISTS idx_activity_logs_module_date ON activity_logs(module_id, created_at);

CREATE OR REPLACE FUNCTION prevent_multiple_active_modules()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    UPDATE modules SET status = 'ARCHIVED' WHERE status = 'ACTIVE' AND id <> NEW.id;
    NEW.activated_at = COALESCE(NEW.activated_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS modules_active_guard ON modules;
CREATE TRIGGER modules_active_guard
BEFORE INSERT OR UPDATE OF status ON modules
FOR EACH ROW EXECUTE FUNCTION prevent_multiple_active_modules();

-- Usuario administrador de demostración. Cambiar la contraseña en producción.
INSERT INTO modules (name, status, activated_at)
SELECT 'Módulo demostración', 'ACTIVE', now()
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE status = 'ACTIVE');

INSERT INTO app_users (email, password_hash, full_name, role)
VALUES ('admin@asistencia.local', crypt('Admin123*', gen_salt('bf')), 'Administrador', 'ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO class_dates (module_id, class_date, start_time, end_time)
SELECT id, '2026-10-05', '18:00', '21:00'
FROM modules WHERE status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM class_dates WHERE class_date = '2026-10-05');

INSERT INTO class_dates (module_id, class_date, start_time, end_time)
SELECT id, '2026-10-07', '18:00', '21:00'
FROM modules WHERE status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM class_dates WHERE class_date = '2026-10-07');
