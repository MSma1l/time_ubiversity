# Orar Univer · Telegram Bot + Mini App

Mini App mobilă (deschisă din Telegram) pentru organizarea orelor universitare, cu roluri
**Student** și **Profesor**, orar pe săptămâni **pare/impare** și memento-uri trimise de bot
înainte de începutul fiecărei ore.

## Funcționalități

- **Orar personal** — ore cu disciplină, grupă, profesor, sală, zi, interval orar și tip de
  săptămână: `pară`, `impară` sau `în fiecare săptămână`.
- **Roluri Student / Profesor** — rol activ comutabil; fiecare rol poate fi activat/dezactivat
  separat (orele unui rol dezactivat nu mai generează memento-uri).
- **Memento-uri Telegram** — pentru fiecare oră se alege cu câte minute înainte (0–180) trimite
  botul mesajul; memento-urile apar și în lista de notificări din Mini App.
- **Calendar academic** — semestrele se configurează din variabila `SEMESTERS`, iar paritatea
  repornește la fiecare semestru. Sărbătorile legale ale Moldovei (inclusiv cele mobile, legate de
  Paștele ortodox) sunt cunoscute automat; în zilele libere și în afara semestrelor orele rămân
  vizibile, dar botul tace.
- **Catalog Profesor** (PostgreSQL) — grupe, studenți, prezență pe zile
  (prezent / absent / întârziat) și note la laboratoare (0–10).
- **Comenzi bot** (doar în chat privat): `/start`, `/help`, `/azi`, `/saptamana`,
  `/rol student|profesor`, `/notificari on|off`, `/status`.

## Stack

| Zonă | Tehnologii |
|---|---|
| Backend | Node 22, TypeScript, Express 5, zod, helmet, node-cron |
| Stocare | SQLite (`better-sqlite3`): profiluri, ore, notificări, memento-uri livrate · PostgreSQL 16: Catalog Profesor |
| Frontend | React 19 + Vite, servit de nginx (proxy `/api/` și `/telegram/` către `api:3001`) |
| Infrastructură | Docker Compose (`postgres`, `api`, `web`), Caddy ca proxy HTTPS pe host |

## Structura proiectului

```
backend/                 API + bot Telegram + memento-uri (vezi backend/README.md)
frontend/                Mini App React; nginx.conf pentru imaginea de producție
deploy/                  deploy.sh, backup.sh, Caddyfile
docker-compose.yml       stiva de producție
docker-compose.dev.yml   override local: expune PostgreSQL și API-ul pe localhost
.env.example             variabile Compose (POSTGRES_*, WEB_PORT, WEB_BIND)
backend/.env.example     variabile aplicație (token bot, URL-uri, securitate, SEMESTERS)
frontend/.env.example    variabile Vite (VITE_API_URL, VITE_DEV_TELEGRAM_ID, VITE_DEMO_MODE)
```

Detalii despre componente, fluxul datelor și schema bazelor de date:
[docs/ARHITECTURA.md](docs/ARHITECTURA.md). Documentația API-ului: [backend/README.md](backend/README.md).

## Pornire rapidă locală (fără Docker)

Cerințe: Node 22 și npm.

```sh
cp backend/.env.example backend/.env
npm install --prefix backend
npm install --prefix frontend
```

În `backend/.env` modifică pentru dezvoltare:

```ini
NODE_ENV=development      # exemplul are "production", care interzice ALLOW_DEV_AUTH
ALLOW_DEV_AUTH=true       # acceptă headerul X-Dev-Telegram-Id
TELEGRAM_BOT_TOKEN=       # opțional local; fără token botul și memento-urile sunt oprite
ALLOWED_ORIGINS=http://localhost:5173
DATABASE_URL=             # gol = Catalogul Profesor răspunde 503; vezi secțiunea Docker pentru PostgreSQL
```

Pornește cele două servere (în terminale separate):

```sh
npm run dev --prefix backend    # API pe http://localhost:3001 (tsx watch)
npm run dev --prefix frontend   # Mini App pe http://localhost:5173
```

Serverul Vite face proxy pentru `/api` și `/telegram` către `127.0.0.1:3001`.
Modurile Mini App-ului în afara Telegram:

- **demo** (implicit pe serverul Vite) — date de exemplu, nimic nu se salvează pe server;
- **dev** — cu `VITE_DEV_TELEGRAM_ID=<id numeric>` (ex. în `frontend/.env.local`), aplicația
  trimite `X-Dev-Telegram-Id` și lucrează cu API-ul real (necesită `ALLOW_DEV_AUTH=true`).

`VITE_DEV_TELEGRAM_ID` este ignorat în build-ul de producție. Un build de producție deschis în
afara Telegram cere deschiderea aplicației din bot (excepție: build cu `VITE_DEMO_MODE=true`).
Cele trei variabile `VITE_*` sunt explicate în [`frontend/.env.example`](frontend/.env.example)
(`cp frontend/.env.example frontend/.env.local`); sunt încorporate în bundle la build, deci nu
pune niciodată secrete acolo.

## Pornire cu Docker (local)

```sh
cp .env.example .env                    # setează POSTGRES_PASSWORD (ex.: openssl rand -hex 24)
cp backend/.env.example backend/.env    # completează TELEGRAM_BOT_TOKEN, MINI_APP_URL, ALLOWED_ORIGINS
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

| Serviciu | Adresă pe host |
|---|---|
| Mini App (nginx) | `http://127.0.0.1:8083` (`WEB_BIND`:`WEB_PORT`) |
| API (doar cu override-ul dev) | `http://127.0.0.1:3001` |
| PostgreSQL (doar cu override-ul dev) | `127.0.0.1:55434` |

Observații:

- Compose forțează `NODE_ENV=production`, `PORT`, `HOST=0.0.0.0`, `DATABASE_PATH=/data/orar.sqlite`
  și construiește `DATABASE_URL` din `POSTGRES_*` din `.env`-ul din rădăcină. În producție
  `TELEGRAM_BOT_TOKEN` este obligatoriu, iar `ALLOW_DEV_AUTH=true` este refuzat.
- Parola PostgreSQL se aplică doar la prima creare a volumului (vezi comentariile din `.env.example`).
- Fără `docker-compose.dev.yml` doar serviciul `web` publică un port.
- Pentru a folosi PostgreSQL-ul din Docker cu backend-ul pornit local:
  `DATABASE_URL=postgresql://orar:<parola>@127.0.0.1:55434/orar`.

## Comenzi utile

| Comandă | Efect |
|---|---|
| `npm run dev --prefix backend` | API în mod watch (`tsx watch src/index.ts`) |
| `npm run build --prefix backend` | compilare TypeScript în `backend/dist` |
| `npm start --prefix backend` | rulează `dist/index.js` |
| `npm test --prefix backend` | suita Vitest (config, validare, API, bot, memento-uri, catalog); rulează fără PostgreSQL — testele de catalog sunt sărite dacă lipsește `DATABASE_URL_TEST` |
| `npm run dev --prefix frontend` | server Vite pe portul 5173 |
| `npm run build --prefix frontend` | `tsc -b` + `vite build` în `frontend/dist` |
| `npm run lint --prefix frontend` | ESLint, fără avertismente permise |
| `docker compose logs -f api` | loguri API |
| `docker compose ps` | starea și health-check-urile containerelor |

## Producție pe scurt

1. VPS cu Docker Compose v2; domeniu cu DNS către VPS, porturile 80/443 deschise.
2. `cp .env.example .env` și `cp backend/.env.example backend/.env`, apoi completează:
   `POSTGRES_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `MINI_APP_URL` (HTTPS), `ALLOWED_ORIGINS` și
   `SEMESTERS` (calendarul academic — vezi mai jos; lăsat gol, se folosește semestrul implicit).
3. Alege **un singur** mod pentru bot: `TELEGRAM_POLLING=true` sau webhook
   (`TELEGRAM_POLLING=false`, `WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`). Nu porni două instanțe cu același token.
4. `./deploy/deploy.sh` — validează configurația, construiește, pornește și așteaptă health-check-urile.
5. Caddy pe host (`deploy/Caddyfile`) face HTTPS și trimite traficul la `127.0.0.1:8083`.
6. În @BotFather setează Menu Button / Web App URL la exact valoarea din `MINI_APP_URL`.
7. Backup zilnic cu `./deploy/backup.sh` (PostgreSQL `pg_dump` + copie online SQLite).

Ghidul complet (instalare, actualizare, restaurare backup, depanare): [docs/DEPLOY.md](docs/DEPLOY.md).

## Semestre și săptămâni pare / impare

Calendarul academic se configurează din variabila de mediu **`SEMESTERS`**, în formatul
`START:even|odd[:END]`, intrările separate prin virgulă:

```ini
SEMESTERS=2026-09-07:even:2026-12-20,2027-02-01:even:2027-05-30
```

- `START` trebuie să fie o **luni** — prima luni a semestrului — și dă paritatea primei săptămâni.
- `END` este inclusiv și poate lipsi doar la ultima intrare; semestrele nu se pot suprapune.
- **Paritatea și numerotarea repornesc la fiecare semestru**, așa că vacanța de iarnă nu mai
  consumă paritate și nu mai poate inversa semestrul II.
- O valoare greșită oprește API-ul la pornire, cu lista completă a problemelor.
- Lăsată **goală**, se păstrează exact comportamentul anterior: un singur semestru fără sfârșit,
  început la `2026-09-07`, săptămână pară. Toate calculele sunt în fusul `Europe/Chisinau`, cu
  săptămâni care încep lunea.

`GET /api/week` este singura sursă de adevăr: întoarce numărul și paritatea săptămânii, semestrul
din care face parte data, lista semestrelor configurate și zilele nelucrătoare ale săptămânii
afișate. Detalii: [docs/ARHITECTURA.md](docs/ARHITECTURA.md), secțiunea 5.

**Zile fără ore.** Sărbătorile legale ale Republicii Moldova sunt adăugate automat pentru anul curent
și pentru următorul (cele cu dată fixă și cele mobile, derivate din Paștele ortodox calculat), la care
se adaugă zilele marcate manual pe server. Perioadele din afara semestrelor sunt nelucrătoare prin
construcție, fără să fie nevoie să enumere cineva vacanța de vară. În toate aceste zile **orele rămân
vizibile în orar — se opresc doar memento-urile.**

Orarul UTM în PDF este o foaie vizuală cu celule unite, de aceea orele se introduc și se
editează manual în Mini App, în locul unei extrageri automate fragile.

## Securitate pe scurt

- Fiecare cerere `/api` trimite `Telegram.WebApp.initData` în headerul `X-Telegram-Init-Data`;
  serverul verifică semnătura HMAC cu tokenul botului și vârsta datelor (`INIT_DATA_MAX_AGE_SECONDS`,
  implicit **1 oră**: `initData` e o credențială de tip bearer, fără revocare, deci fereastra stă scurtă).
- Toate datele sunt filtrate după utilizatorul autentificat; Catalogul Profesor cere modul Profesor
  activ (altfel 403) și verifică proprietarul grupei.
- `X-Dev-Telegram-Id` funcționează doar cu `ALLOW_DEV_AUTH=true`, refuzat când `NODE_ENV=production`.
- Tokenul botului **nu ajunge niciodată în frontend sau în Git**; `.env` și `backend/.env` sunt în `.gitignore`.
- Webhook-ul Telegram este acceptat doar cu `X-Telegram-Bot-Api-Secret-Token` corect.
- Validare zod, limită de corp JSON 64 KB, rate limiting per IP și per utilizator, helmet + CSP în nginx.
- În producție PostgreSQL și API-ul nu publică porturi; `web` ascultă doar pe `127.0.0.1`.

Constatările auditului și corecturile aplicate: [docs/AUDIT.md](docs/AUDIT.md).
