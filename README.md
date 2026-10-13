## Requisitos

- Node.js 18 o superior.
- PostgreSQL 14 o superior.
- Base de datos creada con `database/schema.sql`.

## Instalación

npm install

## Ejecución del backend

npm run dev

### Crear el archivo .env con el contenido de .env.example, y adecuar las credenciales de conexion a postgres.

| `PORT` | Puerto donde escuchará la API. | `3000` |
| `DATABASE_URL` | Cadena de conexión a PostgreSQL. Tiene el formato `postgres://USUARIO:CONTRASEÑA@HOST:PUERTO/BASE`. | `postgres://postgres:postgres@localhost:5432/control_asistencia` |
| `JWT_SECRET` | Clave privada usada para firmar las sesiones. Debe ser larga, aleatoria y diferente en producción. | `mi-clave-secreta-larga` |
| `CLIENT_URL` | URL permitida para las solicitudes del frontend mediante CORS. | `http://localhost:5173` |
