# Backend — Sistema de Registro y Control de Asistencia

API REST para el control de asistencia de un módulo académico. Permite el acceso de estudiantes (por correo o número de registro) y de administradores (con credenciales), la marcación y corrección de asistencias, la importación de estudiantes y fechas de clase desde Excel, la consulta de actividades y la activación de nuevos módulos conservando el histórico.

## Stack tecnológico

| Capa              | Tecnología                                      |
| ----------------- | ----------------------------------------------- |
| Runtime           | Node.js 18 o superior (ESM, `"type": "module"`) |
| Framework         | Express 4                                       |
| Base de datos     | PostgreSQL 14+ (probado en PostgreSQL 18)       |
| Acceso a datos    | `pg` (driver de PostgreSQL)                     |
| Autenticación     | JSON Web Tokens (`jsonwebtoken`) + `bcryptjs`   |
| Carga de archivos | `multer` (en memoria, máx. 5 MB)                |
| Excel             | `xlsx`                                          |
| Otros             | `cors`, `dotenv`                                |
| Desarrollo        | `nodemon`                                       |

## Estructura del proyecto

```text
backend-control-asistencia/
  src/
    server.js        # Definición de la API (rutas, validaciones, auditoría)
    middleware.js    # Autenticación JWT (con revocación) y autorización de admin
    db.js            # Pool de conexiones y helper query()
  schema.sql         # DDL: base de datos, tablas, triggers, extensiones y seeds
  alumnos.xlsx       # Ejemplo de Excel de estudiantes
  horarios.xlsx      # Ejemplo de Excel de fechas/horarios
  .env.example       # Plantilla de variables de entorno
  package.json
```

## Requisitos previos

- Node.js 18 o superior.
- PostgreSQL 14 o superior en ejecución.
- pgAdmin u otro cliente SQL (opcional, para administrar la base de datos).

## 1. Crear la base de datos

El script `schema.sql` crea la base de datos `control_asistencia`, las extensiones (`citext`, `pgcrypto`, `unaccent`), todas las tablas, restricciones, índices, el trigger de módulo único, el administrador de demostración y algunas fechas de ejemplo.

Desde la consola (ajusta la ruta de `psql` según tu instalación):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -f schema.sql
```

O desde pgAdmin: selecciona el servidor, abre el **Query Tool** y ejecuta el contenido de `schema.sql`.

> El script es idempotente (usa `IF NOT EXISTS` y `ON CONFLICT`), por lo que puede ejecutarse nuevamente sin perder datos.

## 2. Configurar variables de entorno

Copia `.env.example` a `.env` y ajusta los valores:

```powershell
Copy-Item .env.example .env
```

| Variable       | Descripción                                                                                   | Valor de desarrollo                                               |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PORT`         | Puerto donde escucha la API.                                                                  | `3000`                                                            |
| `DATABASE_URL` | Cadena de conexión a PostgreSQL con formato `postgres://USUARIO:CONTRASEÑA@HOST:PUERTO/BASE`. | `postgres://postgres:reymar123@localhost:5432/control_asistencia` |
| `JWT_SECRET`   | Clave privada para firmar las sesiones. Debe ser larga, aleatoria y distinta en producción.   | _(genera una propia)_                                             |
| `CLIENT_URL`   | URL del frontend permitida por CORS.                                                          | `http://localhost:5173`                                           |

## 3. Conectar la base de datos desde pgAdmin

Registra un nuevo servidor (**Object → Register → Server**) con estos datos:

| Parámetro                      | Valor                    |
| ------------------------------ | ------------------------ |
| Nombre (libre)                 | `Control de Asistencia`  |
| Host / Servidor                | `localhost`              |
| Puerto                         | `5432`                   |
| Base de datos de mantenimiento | `postgres`               |
| Base de datos de la aplicación | `control_asistencia`     |
| Usuario                        | `postgres`               |
| Contraseña                     | `tu_contraseña`          |
| Modo de conexión               | Prefer / sin SSL (local) |

Pasos: en la pestaña **General** asigna un nombre; en **Connection** escribe `localhost`, `5432`, usuario `postgres` y la contraseña; guarda y expande el nodo hasta **Databases → control_asistencia → Schemas → public → Tables** para ver las tablas.

## 4. Instalar y ejecutar

```powershell
npm install
npm run dev      # desarrollo con recarga automática (nodemon)
npm start        # ejecución simple con node
```

Comprobación rápida del servicio:

```powershell
Invoke-RestMethod http://localhost:3000/api/health   # -> { "status": "ok" }
```

## Credenciales de demostración

| Rol           | Usuario                                       | Contraseña                 |
| ------------- | --------------------------------------------- | -------------------------- |
| Administrador | `admin@asistencia.local`                      | `Admin123*`                |
| Estudiante    | correo o número de registro del módulo activo | _(no requiere contraseña)_ |

> Cambia la contraseña del administrador en producción. Los estudiantes acceden solo con un identificador que pertenezca al módulo activo.

## Requerimientos funcionales implementados

| Código | Requerimiento                                                                 | Estado             | Dónde se implementa                                                                                                                |
| ------ | ----------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| RF-01  | Ingreso de estudiante por correo o registro; debe pertenecer al módulo activo | ✅ Implementado    | `POST /api/auth/login` (valida pertenencia al módulo activo)                                                                       |
| RF-02  | Administrador con credenciales, autorización y cierre de sesión               | ✅ Implementado    | `POST /api/auth/login`, `requireAdmin`, `POST /api/auth/logout` (revoca el token)                                                  |
| RF-03  | Marcar una sola vez en la fecha programada y guardar fecha/hora reales        | ✅ Implementado    | `POST /api/attendance` (restricción `UNIQUE(student_id, class_date_id)`; 2.ª marca → `409`)                                        |
| RF-04  | Falta al terminar la fecha sin marca; solo el admin corrige el pasado         | ✅ Implementado    | Estado `ABSENT` derivado cuando `class_date < CURRENT_DATE`; corrección solo por admin (`PATCH`)                                   |
| RF-05  | Historial personal de fechas, estados, hora y totales                         | ✅ Implementado    | `GET /api/attendance` y `GET /api/attendance/summary` (alcance del propio estudiante)                                              |
| RF-06  | Listar estudiantes con registro, nombre, correo y búsqueda                    | ✅ Implementado    | `GET /api/students` (búsqueda por nombre o registro, sin distinguir mayúsculas ni acentos)                                         |
| RF-07  | Admin cambia Presente/Falta/Retraso en fechas programadas y se audita         | ✅ Implementado    | `PATCH /api/attendance/:studentId/:classDateId` + `activity_logs` (estado anterior/nuevo)                                          |
| RF-08  | Vista general, filtros por fecha/estudiante y totales                         | ✅ Implementado    | `GET /api/attendance` y `GET /api/attendance/summary` (filtros `date`, `studentId`)                                                |
| RF-09  | Actividades importantes con usuario, acción, fecha/hora y registro afectado   | ✅ Implementado    | Tabla `activity_logs`; acciones `MARK_ATTENDANCE`, `UPDATE_ATTENDANCE`, `ACTIVATE_MODULE`, `IMPORT_STUDENTS`, `IMPORT_CLASS_DATES` |
| RF-10  | Historial de actividades del módulo activo con filtros por estudiante/fecha   | ✅ Implementado    | `GET /api/activity-logs` (filtros `date` y `studentId`; solo admin)                                                                |
| RF-11  | Importar Excel de estudiantes con validación de obligatorios y duplicados     | ✅ Implementado    | `POST /api/import/students` (transacción por fila, validación de encabezados/correo/extensión/límite)                              |
| RF-12  | Importar Excel de fechas con hora inicio/fin; no restringir por hora          | ✅ Implementado    | `POST /api/import/class-dates` (valida formato y `fin > inicio`)                                                                   |
| RF-13  | Activar un nuevo módulo con confirmación y sin asistencias iniciales          | ✅ Implementado    | `POST /api/modules/activate` (transaccional; archiva el anterior y deja el nuevo vacío)                                            |
| RF-14  | Persistir estudiantes, módulos, fechas, asistencias y actividades             | ✅ Implementado    | Esquema relacional en PostgreSQL (`schema.sql`)                                                                                    |
| RF-15  | Conservar registros de módulos anteriores asociados a su módulo               | ✅ Implementado    | Los módulos pasan a `ARCHIVED`; las consultas filtran por el módulo activo                                                         |
| RF-16  | _(Opcional)_ Vista previa de estudiantes y fechas antes de activar            | ❌ No implementado | —                                                                                                                                  |
| RF-17  | _(Opcional)_ Exportar a Excel las asistencias del módulo activo               | ❌ No implementado | —                                                                                                                                  |
| RF-18  | _(Opcional)_ Mensajes de confirmación/error al marcar, importar o modificar   | ✅ Implementado    | Respuestas JSON con `message`/`code`; el frontend muestra avisos y errores                                                         |

### Reglas de negocio

| Código | Regla                                                     | Estado                                                   |
| ------ | --------------------------------------------------------- | -------------------------------------------------------- |
| RN-01  | Un solo módulo activo                                     | ✅ Índice único parcial `one_active_module` + trigger    |
| RN-02  | Registro de estudiante único dentro del módulo activo     | ✅ `UNIQUE (module_id, registration_number)`             |
| RN-03  | Una marca por estudiante y fecha de clase                 | ✅ `UNIQUE (student_id, class_date_id)`                  |
| RN-04  | El estudiante solo marca el día programado                | ✅ `class_date = CURRENT_DATE` en `POST /api/attendance` |
| RN-05  | Al finalizar el día, ausencia de marca = Falta            | ✅ Estado `ABSENT` derivado                              |
| RN-06  | Solo el administrador modifica asistencias fuera de fecha | ✅ `requireAdmin` en `PATCH`                             |
| RN-07  | Toda modificación administrativa se audita                | ✅ `activity_logs` dentro de transacción                 |
| RN-08  | El reinicio conserva la historia                          | ✅ Persistencia en PostgreSQL                            |

## Funcionalidad adicional (más allá de la especificación)

- **Retrasos (`LATE`):** el estudiante puede marcar solo dentro de la ventana `hora inicio`–`hora fin` de la clase; pasado el umbral de **15 minutos** desde el inicio se registra como **Retraso**. El administrador puede fijar `Presente`, `Retraso` o `Falta` en cualquier fecha del módulo activo.
- **Cierre de sesión con revocación:** los tokens cerrados se registran en `revoked_tokens` y se rechazan aunque no hayan expirado (TTL de sesión: 8 h).
- **Identidad por módulo:** el correo del estudiante es único por módulo (índices únicos parciales en `app_users`).
- **Búsqueda natural:** ignora mayúsculas y acentos gracias a la extensión `unaccent` de PostgreSQL.
- **`GET /api/me`:** devuelve la identidad de la sesión y el módulo activo.

## Endpoints de la API

Todas las rutas devuelven JSON. Excepto `login` y `health`, requieren el encabezado `Authorization: Bearer <token>`.

| Método | Endpoint                                  | Rol         | Descripción                                                       |
| ------ | ----------------------------------------- | ----------- | ----------------------------------------------------------------- |
| GET    | `/api/health`                             | Público     | Estado del servicio                                               |
| POST   | `/api/auth/login`                         | Público     | Inicia sesión (admin o estudiante)                                |
| POST   | `/api/auth/logout`                        | Autenticado | Cierra sesión y revoca el token                                   |
| GET    | `/api/me`                                 | Autenticado | Identidad de la sesión y módulo activo                            |
| GET    | `/api/modules/active`                     | Autenticado | Módulo activo                                                     |
| GET    | `/api/students`                           | Admin       | Lista/busca estudiantes del módulo activo                         |
| GET    | `/api/class-dates`                        | Autenticado | Fechas de clase del módulo activo                                 |
| GET    | `/api/attendance`                         | Autenticado | Matriz de asistencias (el estudiante solo ve las suyas)           |
| GET    | `/api/attendance/summary`                 | Autenticado | Totales: presentes, retrasos, faltas, pendientes, % de asistencia |
| POST   | `/api/attendance`                         | Estudiante  | Marca la asistencia de hoy                                        |
| PATCH  | `/api/attendance/:studentId/:classDateId` | Admin       | Corrige el estado de una asistencia                               |
| POST   | `/api/import/students`                    | Admin       | Importa estudiantes desde Excel                                   |
| POST   | `/api/import/class-dates`                 | Admin       | Importa fechas/horarios desde Excel                               |
| POST   | `/api/modules/activate`                   | Admin       | Archiva el módulo actual y activa uno nuevo                       |
| GET    | `/api/activity-logs`                      | Admin       | Historial de actividades (filtros `date`, `studentId`)            |

## Notas

- Las horas de inicio/fin se guardan en el campo `TIME` de PostgreSQL y la comparación de horario usa `LOCALTIME` del servidor.
- La importación de estudiantes escribe en `students` y `app_users` dentro de una transacción por fila; los registros con error se reportan y no interrumpen el resto.
- `alumnos.xlsx` y `horarios.xlsx` (en la raíz del proyecto) sirven como plantillas de ejemplo para las importaciones.
