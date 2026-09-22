# Orar Univer API

API-ul Mini App-ului, botul Telegram și planificatorul de memento-uri rulează în același proces
Node 22 (Express 5 + TypeScript). Orarul, profilurile și notificările stau în **SQLite**; Catalogul
Profesor (grupe, studenți, prezență, note) stă în **PostgreSQL** și este opțional — fără
`DATABASE_URL` restul aplicației funcționează, iar rutele `/api/teacher/*` răspund `503`.

Arhitectura generală: [../docs/ARHITECTURA.md](../docs/ARHITECTURA.md) · Deploy:
[../docs/DEPLOY.md](../docs/DEPLOY.md) · Audit: [../docs/AUDIT.md](../docs/AUDIT.md).

## Pornire locală

```sh
cd backend
cp .env.example .env    # pentru dezvoltare: NODE_ENV=development, ALLOW_DEV_AUTH=true
npm install
npm run dev             # tsx watch src/index.ts -> http://localhost:3001
```

Configurația este validată la pornire (`src/config.ts`); orice valoare invalidă oprește procesul
cu lista tuturor problemelor. Schema SQLite și cea PostgreSQL se creează automat
(`CREATE TABLE IF NOT EXISTS`); conexiunea la PostgreSQL se reîncearcă în fundal cu backoff.

## Autentificare

- Mini App-ul trimite `Telegram.WebApp.initData` în headerul **`X-Telegram-Init-Data`**. Serverul
  verifică semnătura HMAC-SHA256 (cheie derivată din `TELEGRAM_BOT_TOKEN`), vârsta `auth_date`
  (maximum `INIT_DATA_MAX_AGE_SECONDS`, toleranță 60 s în viitor) și câmpul `user`.
- **`X-Dev-Telegram-Id: <id>`** este acceptat **doar** cu `ALLOW_DEV_AUTH=true`, care este refuzat
  când `NODE_ENV=production`. Headerul apare în CORS doar în acest mod.
- Fără token de bot, `initData` nu poate fi verificat: în afara modului dev toate rutele `/api`
  protejate răspund `401`.
- La fiecare cerere autentificată profilul este creat/actualizat, iar toate interogările sunt
  filtrate după utilizator (`owner_id`).

## Endpointuri

Toate rutele `/api/*`, cu excepția health-check-ului, cer autentificare.
Rutele `/api/teacher/*` cer în plus ca **modul Profesor să fie activ** în profil — altfel răspund `403`.

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/health`, `/api/health` | Stare: `200` dacă SQLite merge; `status` = `ok` / `degraded` / `error`, `postgres` = `disabled` / `connecting` / `ready` / `error` |
| GET | `/api/me` | Profilul (`role`, `studentEnabled`, `teacherEnabled`, `remindersEnabled`) + datele Telegram |
| PATCH | `/api/me` | Schimbă `role`, `studentEnabled`, `teacherEnabled`, `remindersEnabled` |
| GET | `/api/week?date=YYYY-MM-DD` | Săptămâna (`number`, `kind` = `even`/`odd`), semestrul care o conține (`inSemester`, `semesterStart`, `semesterEnd`), lista `semesters` din configurație și `nonWorkingDays` ale săptămânii afișate; implicit data de azi la Chișinău |
| GET | `/api/non-working-days?from=&to=` | Zilele nelucrătoare dintr-un interval închis (maximum 400 de zile). Nu există rută de scriere — vezi „Semestre și zile nelucrătoare” |
| GET | `/api/lessons` | Orele utilizatorului |
| POST | `/api/lessons` | Adaugă o oră (maximum 500 per utilizator) → `201` |
| PUT | `/api/lessons/:id` | Modifică o oră proprie → `404` dacă nu există |
| DELETE | `/api/lessons/:id` | Șterge o oră proprie → `204` |
| GET | `/api/notifications` | Ultimele 50 de notificări |
| PATCH | `/api/notifications/read` | Marchează toate notificările ca citite → `204` |
| GET | `/api/teacher/groups` | Grupele profesorului, cu `student_count` |
| POST | `/api/teacher/groups` | Creează o grupă (`name`, `subject`; maximum 200; nume unic → altfel `409`) |
| PATCH | `/api/teacher/groups/:groupId` | Redenumește grupa sau îi schimbă disciplina. Redenumirea **se propagă în orarul de Profesor** al proprietarului |
| DELETE | `/api/teacher/groups/:groupId` | Șterge grupa, studenții, prezența și notele ei → `204`. Orele din orar rămân neatinse |
| GET | `/api/teacher/groups/:groupId/students` | Studenții grupei |
| POST | `/api/teacher/groups/:groupId/students` | Adaugă un student (`firstName`, `lastName`; maximum 500 per grupă) |
| PATCH | `/api/teacher/students/:studentId` | Redenumește un student |
| DELETE | `/api/teacher/students/:studentId` | Șterge un student, cu prezența și notele lui → `204` |
| GET | `/api/teacher/groups/:groupId/attendance?date=` | Prezența grupei pe o dată |
| POST | `/api/teacher/groups/:groupId/attendance` | Prezența pe o dată (`date`, `topic`, `entries[]` cu `studentId` și `status` = `present`/`absent`/`late`), tranzacțional → `204` |
| GET | `/api/teacher/students/:studentId/grades` | Notele de laborator ale unui student |
| POST | `/api/teacher/students/:studentId/grades` | Notă la laborator (`laboratory`, `grade` 0–10, `presentedOn`, `feedback`) |
| POST | `/telegram/webhook` | Update-uri Telegram (doar în modul webhook, vezi mai jos) |

Câmpurile unei ore (`POST`/`PUT /api/lessons`): `role` (`student`/`teacher`), `title`, `groupName`,
`teacherName`, `room`, `weekday` (1 = luni … 7 = duminică), `startTime`, `endTime` (`HH:MM`),
`weekKind` (`even` / `odd` / `every`), `reminderMinutes` (0–180), `notificationsEnabled`.
Schemele exacte: `src/validation.ts`.

Erori: JSON `{ "error": "..." }` cu mesaje în română; validarea zod întoarce `400` cu `fields[]`.
Alte coduri: `401` autentificare, `404`, `409` (limită atinsă / duplicat), `413` corp peste 64 KB,
`429` rate limit (cu `Retry-After`), `503` Catalog Profesor indisponibil.

## Variabile de mediu

Exemplu complet: [`.env.example`](.env.example). În Docker Compose `NODE_ENV`, `PORT`,
`DATABASE_PATH` și `DATABASE_URL` sunt suprascrise din `docker-compose.yml`.

| Variabilă | Implicit | Descriere |
|---|---|---|
| `NODE_ENV` | — | `production` activează validarea strictă: token obligatoriu, `ALLOW_DEV_AUTH` interzis |
| `PORT` | `3001` | Port HTTP (1–65535) |
| `HOST` | `0.0.0.0` | Interfața pe care ascultă serverul |
| `TELEGRAM_BOT_TOKEN` | gol | Token @BotFather; fără el sunt oprite autentificarea Telegram, botul și memento-urile |
| `MINI_APP_URL` | gol | URL-ul public al Mini App-ului; butonul „Deschide” apare doar dacă e `https://` |
| `TELEGRAM_POLLING` | `false` | `true` = long polling; altfel modul webhook |
| `WEBHOOK_URL` | gol | URL `https://…/telegram/webhook` înregistrat automat la pornire |
| `TELEGRAM_WEBHOOK_SECRET` | derivat | Secret webhook (`A-Z a-z 0-9 _ -`, max. 256); dacă lipsește se derivă din token (SHA-256) |
| `INIT_DATA_MAX_AGE_SECONDS` | `3600` | Vârsta maximă a `initData` (60–604800). `initData` e o credențială purtătoare fără revocare, deci fereastra se ține scurtă |
| `ALLOWED_ORIGINS` | gol | Origini CORS separate prin virgulă; gol = fără CORS cross-origin |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Setarea Express `trust proxy` (`true`, `false`, număr de hop-uri sau listă) |
| `RATE_LIMIT_PER_MINUTE` | `120` | Cereri/minut per utilizator; per IP limita este de 5×; `0` dezactivează |
| `ALLOW_DEV_AUTH` | `false` | Acceptă `X-Dev-Telegram-Id` (doar dezvoltare) |
| `DATABASE_PATH` | `./data/orar.sqlite` | Fișierul SQLite (în Docker: `/data/orar.sqlite`, volum) |
| `DATABASE_URL` | gol | Conexiune PostgreSQL pentru Catalogul Profesor; gol = catalog dezactivat |
| `SEMESTERS` | gol | Calendarul academic, `START:even\|odd[:END]` separate prin virgulă. Gol = un singur semestru deschis, 7 septembrie 2026, săptămână pară |

Valorile booleene acceptă `1`, `true`, `yes`, `on`.

## Botul: polling sau webhook

Folosește **exact un mod** per token; două instanțe care citesc același token intră în conflict (`409`).

**Polling** (`TELEGRAM_POLLING=true`) — cel mai simplu, nu cere URL public. La pornire serverul
apelează `deleteWebhook`, apoi `getUpdates` în buclă, cu backoff la erori.

**Webhook** (`TELEGRAM_POLLING=false`) — setează în `.env`:

```ini
TELEGRAM_POLLING=false
WEBHOOK_URL=https://orar.example.md/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
```

La pornire serverul **înregistrează singur** webhook-ul prin `setWebhook` cu `secret_token`
și `allowed_updates: ["message"]`, reîncercând în fundal până reușește. Nu mai este nevoie de un
`curl` manual: un `setWebhook` fără `secret_token` ar face ca fiecare update să primească `401`,
pentru că ruta verifică headerul `X-Telegram-Bot-Api-Secret-Token`. Update-urile valide primesc
mereu `200`, chiar dacă procesarea eșuează, ca Telegram să nu le retrimită la nesfârșit.
În spatele nginx, `/telegram/` este redirecționat către `api:3001`.

Comenzi (doar în chat privat, datele sunt legate de expeditor): `/start`, `/help`, `/azi`,
`/saptamana`, `/rol student|profesor`, `/notificari on|off`, `/status`.

## Memento-uri

Implementare: `src/reminders.ts`, `src/schedule.ts`, planificare în `src/index.ts`.

- Un job `node-cron` rulează **în fiecare minut** în fusul `Europe/Chisinau`, doar dacă există
  `TELEGRAM_BOT_TOKEN`; o rulare nu pornește cât timp precedenta nu s-a terminat.
- Sunt verificate orele de ieri, azi și mâine (un memento poate trece de miezul nopții) cu
  `notificationsEnabled`, care se aplică în săptămâna respectivă (`even`/`odd`/`every`) și al căror
  rol nu este dezactivat în profil (`studentEnabled` / `teacherEnabled`).
- Memento-ul pleacă când s-au atins `reminderMinutes` înainte de start. Fereastra de recuperare
  ține cât timp ora încă nu a început — `max(5, reminderMinutes)` minute — ca un restart sau un
  deploy să nu piardă memento-ul; după start mai sunt tolerate 5 minute. Textul:
  „În N min: …”, „Acum începe: …” sau „A început acum N min: …”,
  cu ora, sala și grupa, plus butonul „Deschide orarul” dacă `MINI_APP_URL` e HTTPS.
- Fiecare apariție (`lesson_id` + **data** ocurenței) este rezervată în `delivered_reminders`
  **înainte** de trimitere, deci restarturile sau tick-urile suprapuse nu dublează mesajele.
- Erorile `400`/`403` de la Telegram (chat inexistent, bot blocat) sunt definitive; la alte erori
  rezervarea se anulează și memento-ul se reîncearcă la tick-ul următor, în fereastra de toleranță.
- După trimitere se salvează și o notificare `reminder`, vizibilă în Mini App.
- Mentenanță zilnică la 04:17 (Chișinău): se șterg înregistrările de memento-uri mai vechi de
  14 zile și notificările mai vechi de 180 de zile.

## Semestre și zile nelucrătoare

Paritatea săptămânilor **repornește la fiecare semestru**, ca să nu fie consumată de vacanțe.
Calendarul se configurează prin `SEMESTERS`, fără recompilare; fiecare intrare e
`START:even|odd[:END]`, unde `START` trebuie să fie o zi de luni. Cu valoarea implicită,
7–13 septembrie 2026 este săptămâna nr. 1 și este **pară**, iar săptămânile alternează de acolo —
exact comportamentul dinainte de introducerea semestrelor.

O dată din afara oricărui semestru păstrează o paritate afișabilă (se prelungește ultimul semestru
început), dar **nu produce memento-uri**.

Zilele nelucrătoare stau în `non_working_days`. Sărbătorile legale ale Moldovei sunt semănate
automat pentru anul curent și următorul, inclusiv cele mobile derivate din Paștele ortodox, care e
calculat, nu scris de mână. O zi nelucrătoare **nu ascunde orele** — utilizatorul vede în
continuare ce ar fi fost — dar oprește memento-urile acelei zile.

Nu există rută de scriere pentru zilele nelucrătoare: aplicația nu are noțiune de administrator,
iar o astfel de rută accesibilă oricui ar lăsa un singur utilizator să oprească memento-urile
tuturor. Până la un model de administrator, zilele proprii se adaugă pe server.

## Build și teste

```sh
npm run build   # tsc -> dist/
npm start       # node dist/index.js
npm test        # vitest run — 45 de teste în 8 fișiere
```

Testele (`src/*.test.ts`) acoperă configurația, validarea `initData`, rutele API, botul,
calculul săptămânilor, memento-urile, validarea și rate limiting-ul. Nu necesită PostgreSQL
sau acces la Telegram.

La oprire (`SIGTERM`/`SIGINT`) procesul oprește job-urile cron și polling-ul, închide serverul
HTTP, așteaptă rularea de memento-uri în curs și închide bazele de date (timeout forțat 10 s).
