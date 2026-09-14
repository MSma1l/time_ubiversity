# Arhitectura Orar Univer — harta proiectului

Orar Univer este un bot Telegram cu Mini App pentru orarul universitar. Are două roluri
(Student/Profesor), săptămâni pare/impare, memento-uri în Telegram și un catalog pentru profesor
(grupe, studenți, prezență, note). Documente înrudite: [README](../README.md) ·
[backend/README](../backend/README.md) · [DEPLOY](DEPLOY.md) · [AUDIT](AUDIT.md).

## 1. Diagramă generală

```mermaid
flowchart LR
  U["Client Telegram<br/>(WebView Mini App + chat)"] -->|HTTPS| C["Caddy pe host<br/>TLS Let's Encrypt, HSTS"]
  C -->|"127.0.0.1:WEB_PORT (8083)"| W["web: nginx:1.27-alpine<br/>CSP, headere, gzip"]
  W -->|"/, /assets/*"| S["SPA React (dist static)"]
  W -->|"/api/*, /telegram/*"| A["api: Node 22 + Express 5<br/>port 3001 (neexpus)"]
  A --> L[("SQLite (better-sqlite3)<br/>volum orar-data:/data")]
  A --> P[("PostgreSQL 16<br/>volum postgres-data")]
  A <-->|"getUpdates (polling) sau setWebhook"| T["Telegram Bot API"]
  T -.->|"webhook POST /telegram/webhook"| C
  K["node-cron în api<br/>* * * * * memento-uri<br/>17 4 * * * curățenie"] --> A
  A -->|sendMessage| T
```

Containerele (`docker-compose.yml`): `postgres` → `api` (pornește după healthcheck Postgres) →
`web` (pornește după healthcheck api). Doar `web` publică un port, legat implicit la `127.0.0.1`.
`docker-compose.dev.yml` expune suplimentar Postgres pe `127.0.0.1:55434` și API-ul pe `127.0.0.1:3001`.

## 2. Arborele de directoare

```text
.
├── docker-compose.yml        # stiva de producție: postgres, api, web; limite memorie, no-new-privileges, loguri rotite
├── docker-compose.dev.yml    # override local: porturi 55434 (Postgres) și 3001 (API) pe localhost
├── .env.example              # variabile Compose: POSTGRES_*, WEB_PORT, WEB_BIND, BACKUP_*
├── deploy/
│   ├── Caddyfile             # proxy HTTPS pe host → 127.0.0.1:8083, HSTS, health_uri /nginx-health
│   ├── deploy.sh             # verifică .env-urile, build, chown /data, up -d, așteaptă healthy
│   └── backup.sh             # pg_dump + backup SQLite online (.backup), SHA256SUMS, retenție N zile
├── backend/                  # API + bot + cron (Node 22, TypeScript, ESM)
│   ├── Dockerfile            # multi-stage node:22-alpine, tini, USER node, VOLUME /data
│   ├── .env.example          # token bot, MINI_APP_URL, polling/webhook, CORS, rate limit
│   └── src/
│       ├── index.ts          # punct de intrare: config, DB, HTTP, cron, polling/webhook, oprire grațioasă
│       ├── app.ts            # createApp(): helmet, CORS, rate limit, auth initData, toate rutele, handler erori
│       ├── config.ts         # loadConfig() cu validare (ConfigError), miniAppButton() doar pentru https
│       ├── db.ts             # SQLite: schemă, migrare coloane profil, helper-e lecții/notificări, prune
│       ├── academic.ts       # pool pg, schema catalogului (advisory lock), retry cu backoff, health
│       ├── bot.ts            # comenzi /start /azi /saptamana /rol /notificari /status; polling; setWebhook
│       ├── reminders.ts      # sendDueReminders(): rezervare înainte de trimitere, eliberare la erori tranzitorii
│       ├── schedule.ts       # ceas Europe/Chisinau, număr/paritate săptămână, dueReminderOccurrence()
│       ├── telegram.ts       # validare HMAC initData, secret webhook, safeEqual, client Bot API cu timeout
│       ├── rateLimit.ts      # limitator fixed-window în memorie + middleware Express (429 + Retry-After)
│       ├── validation.ts     # scheme zod: lecție, profil, grupă, student, prezență, notă, id/uuid
│       ├── util.ts           # sleep() care se întrerupe la AbortSignal
│       └── *.test.ts         # teste vitest pentru fiecare modul de mai sus
└── frontend/                 # Mini App (React 19 + Vite 6)
    ├── Dockerfile            # build Vite → nginx:1.27-alpine, `nginx -t` la build
    ├── nginx.conf            # SPA fallback, proxy /api și /telegram către api:3001, CSP, cache
    ├── vite.config.ts        # dev server 5173, proxy /api și /telegram → 127.0.0.1:3001
    ├── index.html            # încarcă telegram-web-app.js și fontul DM Sans
    └── src/
        ├── main.tsx          # initializeTelegram() + montare <App/> și importul tuturor CSS
        ├── App.tsx           # ecranul principal: sesiune, zile, rol, următoarea oră, panouri, sincronizare
        ├── api.ts            # fetch cu X-Telegram-Init-Data, timeout 15 s, mesaje de eroare RO, mapare DTO
        ├── schedule.ts       # oglinda logicii de paritate/ceas din backend, date demo, formatare
        ├── telegram.ts       # detectSession (telegram/dev/demo/none), confirmAction, BackButton
        ├── dialogs.ts        # useDialog(): stivă de modale, Escape/BackButton, focus restaurat
        ├── labels.ts         # etichete roluri (Student/Profesor), inițiala numelui
        ├── types.ts          # Lesson (weekday 0–6, weekType odd/even/both), AppNotification, Role
        ├── components/
        │   ├── LessonCard.tsx     # card de oră în timeline + BellIcon
        │   ├── LessonEditor.tsx   # formular adăugare/editare/ștergere oră (limite = lessonSchema)
        │   ├── Panels.tsx         # NotificationPanel, CalendarPanel (grilă sloturi Lu–Sâ), ProfilePanel
        │   └── TeacherCatalog.tsx # mod „settings” (grupe, studenți) și „records” (prezență, note)
        └── *.css             # styles (bază, layout), utm (temă, role switch), icons, calendar,
                              # settings (profil, toggle), editor-position, catalog + catalog-refined,
                              # scrollbars (ascunde bara, păstrează scroll-ul)
```

## 3. Model de date

**SQLite** (`DATABASE_PATH`, implicit `/data/orar.sqlite`; WAL, `foreign_keys=ON`, `busy_timeout=5000`) —
orarul personal, critic pentru `/health`.

| Tabel | Coloane principale | Note |
|---|---|---|
| `profiles` | `telegram_id` PK, `display_name`, `role` (student/teacher), `timezone`, `student_enabled`, `teacher_enabled` | upsert la fiecare cerere autentificată și comandă bot |
| `lessons` | `id` PK, `owner_id`, `role`, `title`, `group_name`, `teacher_name`, `room`, `weekday` 1–7, `start_time`, `end_time`, `week_kind` odd/even/every, `reminder_minutes` (0–180, implicit 15), `notifications_enabled`, `created_at`, `updated_at` | index `(owner_id, weekday, start_time)` și parțial pe `weekday` |
| `delivered_reminders` | PK (`lesson_id`, `occurrence_key` = `YYYY-MM-DD-HH:MM`) | deduplicare memento-uri; curățat după 14 zile |
| `notifications` | `id` PK, `owner_id`, `kind` reminder/system, `title`, `body`, `read_at`, `created_at` | ultimele 50 în UI; șterse după 180 zile |

**PostgreSQL** (`DATABASE_URL`) — Catalogul Profesor, opțional (fără el, rutele `/api/teacher/*` răspund 503).
Schema e creată idempotent de `academic.ts` sub `pg_advisory_xact_lock`.

| Tabel | Coloane principale | Constrângeri |
|---|---|---|
| `academic_groups` | `id` UUID, `owner_id` BIGINT (Telegram id), `name`, `subject`, `created_at` | `UNIQUE(owner_id, name)` |
| `students` | `id` UUID, `group_id` → grupă, `first_name`, `last_name` | `ON DELETE CASCADE` |
| `attendance_sessions` | `id` UUID, `group_id`, `occurred_on` DATE, `topic` | `UNIQUE(group_id, occurred_on)` |
| `attendance_entries` | PK(`session_id`, `student_id`), `status` | `CHECK status IN (present, absent, late)` |
| `lab_grades` | `id` UUID, `student_id`, `laboratory`, `grade` NUMERIC(4,2), `presented_on`, `feedback` | `CHECK 0 ≤ grade ≤ 10` |

## 4. Fluxuri cheie

```mermaid
sequenceDiagram
  participant M as Mini App
  participant N as nginx
  participant A as api (Express)
  participant D as SQLite / PostgreSQL
  M->>N: GET /api/lessons + X-Telegram-Init-Data
  N->>A: proxy (X-Forwarded-For, Proto)
  A->>A: rate limit IP (5×limită/min)
  A->>A: validateInitData: hash hex, auth_date ≤ INIT_DATA_MAX_AGE_SECONDS, skew ≤ 60 s
  A->>A: HMAC-SHA256(secret = HMAC("WebAppData", token)), timingSafeEqual
  A->>A: rate limit per user, upsertProfile
  A->>D: SELECT ... WHERE owner_id = user.id
  A-->>M: 200 JSON (sau 401 / 429 / 400 cu fields)
```

- **Autentificare.** Fiecare rută `/api/*` (în afară de `/api/health`) cere header-ul
  `X-Telegram-Init-Data`. `ALLOW_DEV_AUTH=true` acceptă `X-Dev-Telegram-Id`, dar config-ul îl refuză când
  `NODE_ENV=production`. Frontend-ul trimite initData doar dacă e semnat (`detectSession`).
- **CRUD lecții.** zod validează corpul (`endTime > startTime`, fără caractere de control). `POST` are limită
  de 500 de ore per utilizator. `PUT`/`DELETE` folosesc `WHERE id=? AND owner_id=?`, deci o oră străină dă
  404, nu 403. `DELETE` șterge în aceeași tranzacție și rândurile din `delivered_reminders`.
- **Memento-uri.** Cron `* * * * *` cu `timezone: Europe/Chisinau`, fără rulări suprapuse (`reminderRunning`).
  1. Selectează lecțiile de ieri, azi și mâine cu `notifications_enabled=1` și modul rolului activ în profil.
  2. `dueReminderOccurrence()` verifică paritatea săptămânii pentru data ocurenței. Memento-ul e datorat
     când `0 ≤ reminderMinutes − minutesUntilStart ≤ 5`, adică există o fereastră de recuperare de
     5 minute pentru tick-uri întârziate sau un restart — inclusiv la `reminderMinutes = 0` (atunci
     mesajul poate pleca până la 5 min după start: „A început acum N min”). Poate trece de miezul nopții.
  3. Record-before-send: `INSERT OR IGNORE` în `delivered_reminders`, iar mesajul pleacă doar dacă inserarea
     a reușit. La eroare tranzitorie rezervarea e eliberată. La 400/403 (chat blocat) rămâne, fără retry.
  4. După trimitere se scrie o notificare `reminder`. Cron-ul `17 4 * * *` curăță datele vechi.
- **Catalog profesor.** Accesul se verifică prin `owner_id` la fiecare interogare. UUID-urile invalide dau 404.
  Limite: 200 de grupe per profesor și 500 de studenți per grupă. Prezența se salvează într-o tranzacție:
  upsert pe sesiunea zilei, apoi upsert pe intrări prin `unnest ... JOIN students` al grupei. Dacă un student
  nu aparține grupei, se face rollback cu 400. Nota se inserează doar dacă studentul aparține unei grupe a
  profesorului. Erorile Postgres sunt mapate: `23505`→409, `23503`→404, `22P02/22003/23514`→400.
- **Bot.** Răspunde doar în chat privat, la mesaje care încep cu `/`, cu datele cheiate după `from.id`.
  Comenzi: `/start`, `/help`, `/azi`, `/saptamana`, `/rol student|profesor`, `/notificari on|off`
  (comută toate lecțiile utilizatorului), `/status`. Există două moduri de primire, exclusive:
  - polling: `deleteWebhook`, apoi `getUpdates` long-poll de 25 s, cu backoff (409 → 30 s, 401/404 → 5 min);
  - webhook: `setWebhook` cu `secret_token` și retry în fundal; `POST /telegram/webhook` răspunde mereu
    200 după ce secretul e verificat, ca Telegram să nu retrimită update-ul.

## 5. Paritatea săptămânii

Referința este săptămâna **7–13 septembrie 2026 = pară**, cu săptămâna începând luni, în ora `Europe/Chisinau`.
- Backend (`backend/src/schedule.ts`): `universityWeekNumber = round((lunea(dată) − 2026-09-07) / 7 zile) + 1`.
  Numerele impare (…, −1, 1, 3, …) sunt `even`, cele pare sunt `odd`.
- Frontend (`frontend/src/schedule.ts`, `weekTypeFor`): `weeks = round(diferența în săptămâni)`.
  `|weeks| % 2 === 0` înseamnă `even`. Este aceeași regulă, formulată cu offset 0 în loc de 1.
- Datele se calculează la prânz UTC (`T12:00:00Z`), așa că trecerea la ora de vară nu schimbă ziua.
  Ceasul curent vine din `Intl.DateTimeFormat` cu `timeZone: Europe/Chisinau`, indiferent de fusul orar al
  dispozitivului. `GET /api/week` expune numărul, paritatea și referința. Exemplu: 14–20 sept. 2026 = impară.
- Convenții diferite pentru zi: backend și DB folosesc `weekday` 1–7 (Lu=1), UI folosește 0–6 (Lu=0),
  iar `api.ts` face conversia. Tot acolo `every` din backend devine `both` în UI.

## 6. Securitate pe straturi

| Strat | Măsuri |
|---|---|
| Caddy (host) | TLS automat, HSTS 1 an, elimină `Server`; singurul punct public (80/443) |
| nginx (`web`) | CSP strictă pentru SPA (script doar `self` + telegram.org, `frame-ancestors` telegram), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `server_tokens off`, `client_max_body_size 1m`, fișiere ascunse → 404, real IP doar din rețele private |
| Express (`api`) | `helmet`, `x-powered-by` dezactivat, `trust proxy` doar loopback/private, CORS doar pe `ALLOWED_ORIGINS`, JSON ≤ 64 kb, rate limit pe IP și pe utilizator (in-memory, o singură instanță), erori fără stack trace |
| Date | zod pe toate intrările, SQL parametrizat (better-sqlite3 / `$1`), izolare prin `owner_id`, `CHECK`/`UNIQUE` în Postgres |
| Telegram | HMAC initData cu expirare, secret webhook comparat în timp constant, bot doar în chat privat |
| Containere | `USER node` + tini (api), `no-new-privileges`, limite de memorie, Postgres și api fără porturi publicate, `web` legat la 127.0.0.1 |
| Operare | `deploy.sh` refuză `ALLOW_DEV_AUTH=true`, parolă implicită sau `MINI_APP_URL` non-https; `chmod 600` pe `.env`; backup-uri cu `umask 077` |

## 7. Endpoints

Detalii despre corpuri, coduri și exemple: [backend/README.md](../backend/README.md).

| Metodă | Rută | Auth | Rol |
|---|---|---|---|
| GET | `/health`, `/api/health` | — | stare SQLite (critic) + Postgres (`ok`/`degraded`) |
| GET / PATCH | `/api/me` | initData | profil; schimbare rol, `studentEnabled`, `teacherEnabled` |
| GET | `/api/week?date=YYYY-MM-DD` | initData | număr și paritate săptămână |
| GET / POST | `/api/lessons` | initData | listă / creare oră |
| PUT / DELETE | `/api/lessons/:id` | initData + proprietar | modificare / ștergere oră |
| GET | `/api/notifications` | initData | ultimele 50 de notificări |
| PATCH | `/api/notifications/read` | initData | marchează toate ca citite |
| GET / POST | `/api/teacher/groups` | initData | grupele profesorului / grupă nouă |
| GET / POST | `/api/teacher/groups/:groupId/students` | initData + proprietar | studenți / student nou |
| POST | `/api/teacher/groups/:groupId/attendance` | initData + proprietar | prezența pe o dată (upsert) |
| POST | `/api/teacher/students/:studentId/grades` | initData + proprietar | notă de laborator |
| POST | `/telegram/webhook` | secret header | update-uri bot (doar în modul webhook) |
