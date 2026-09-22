# Harta proiectului — Orar Univer

Aplicație de orar universitar livrată ca **Telegram Mini App**, cu un bot Telegram
însoțitor. Două roluri: **Student** (își vede orarul și primește memento-uri) și
**Profesor** (în plus, ține un catalog cu grupe, studenți, prezență și note de laborator).

---

## 1. Vedere de ansamblu

```
                    ┌──────────────────────────────┐
                    │      Telegram (client)       │
                    │  Mini App  +  bot de comenzi │
                    └───────┬──────────────┬───────┘
                            │              │
              initData HMAC │              │ webhook / long polling
                            ▼              ▼
   ┌────────────────────────────────────────────────────────┐
   │  nginx (container `web`) — servește SPA-ul + proxy /api │
   └────────────────────────┬───────────────────────────────┘
                            ▼
   ┌────────────────────────────────────────────────────────┐
   │      Express 5 API (container `api`, port 3001)         │
   │  auth → rate limit → rute REST → cron memento-uri       │
   └───────┬────────────────────────────────┬───────────────┘
           ▼                                ▼
   ┌───────────────┐                ┌──────────────────┐
   │    SQLite     │                │   PostgreSQL 16  │
   │  orar.sqlite  │                │  catalog academic│
   └───────────────┘                └──────────────────┘
```

**De ce două baze de date.** SQLite ține datele personale, mici și foarte des citite
(profiluri, ore, memento-uri livrate, notificări) — o citire locală, fără rețea, la
fiecare cerere. PostgreSQL ține catalogul Profesorului, unde contează integritatea
relațională, tranzacțiile și blocările concurente (grupe → studenți → prezență/note).
Puntea dintre ele este `groupSync.ts`, care leagă o oră din orar de o grupă din catalog
**după nume**, fără să stocheze legătura.

---

## 2. Backend — `backend/src/`

Node 22 · Express 5 · TypeScript ESM strict · zod · better-sqlite3 · pg · node-cron

### Fișiere de infrastructură

| Fișier | Rol |
|---|---|
| `index.ts` | Punctul de intrare al procesului: încarcă `.env`, construiește config + DB (fail-fast cu `exit(1)`), pornește serverul HTTP, inițializează PostgreSQL cu retry în fundal, programează cele două cron-uri (memento-uri în fiecare minut, curățenie zilnică la 04:17 Chișinău), pornește botul și face oprire grațioasă pe SIGTERM/SIGINT. |
| `config.ts` | Singura sursă de adevăr pentru mediu. `loadConfig()` validează tot, adună **toate** problemele și aruncă un singur `ConfigError`. Impune regulile de producție: token obligatoriu, dev-auth interzis. Tot aici se citește și se validează `SEMESTERS` (calendarul academic). |
| `app.ts` | Fabrica `createApp({db, config, log})` — lanțul de middleware, `auth`, rutele REST și handlerul final de erori care traduce ZodError / `HttpError` / coduri SQLSTATE în JSON românesc. Cel mai mare fișier din backend. |
| `db.ts` | Stratul SQLite: pragme (WAL, busy_timeout, chei străine), schema, migrările de compatibilitate cu versiunile vechi, helperele de citire/scriere, zilele nelucrătoare (`non_working_days` / `non_working_seeds`, semănate cu sărbătorile legale) și `pruneDatabase`. |
| `rateLimit.ts` | Limitator in-memory cu fereastră fixă. Folosit pe IP la intrarea în `/api` (5× limita) și pe id-ul Telegram în `auth`. |
| `validation.ts` | Toate schemele zod, cu mesaje de eroare **direct afișabile utilizatorului**, în română. |
| `util.ts` | Un singur helper: `sleep(ms, signal)`. |

### Fișiere de domeniu

| Fișier | Rol |
|---|---|
| `schedule.ts` | Nucleul temporal: fusul `Europe/Chisinau`, modelul de semestre citit din `SEMESTERS` (`parseSemesters`, `semesterOf`, `weekInfo`, `isTeachingDay`) cu paritate care **repornește la fiecare semestru**, aritmetica de zile la ora 12:00 UTC (imună la DST), sărbătorile legale ale Moldovei (`legalHolidays`, inclusiv cele mobile prin `orthodoxEaster`), `appliesInWeek` și `dueReminderOccurrence`. |
| `reminders.ts` | `sendDueReminders`, chemat de cron-ul de fiecare minut. Rezervă fiecare ocurență în `delivered_reminders` **înainte** de trimitere — asta dă garanția „exact o dată" peste restarturi; cheia de deduplicare e **doar data** ocurenței, deci mutarea orei nu re-armează un memento deja trimis azi. Sare peste sărbători, zilele marcate manual și datele din afara semestrelor. |
| `profile.ts` | Profilul și regulile de mod, centralizate în `resolveProfileModes`: cel puțin un mod rămâne activ, rolul cerut trebuie să fie activ, dezactivarea modului curent comută automat pe celălalt. Aruncă `ProfileRuleError` (409) fără să scrie nimic. **Fără fus orar personal** — orarul e al universității, deci un fus per utilizator ar trimite memento-urile la ora greșită; coloana `timezone` din bazele vechi rămâne pe disc, ignorată. |
| `academic.ts` | Stratul PostgreSQL: pool singleton, schema catalogului, migrări idempotente, inițializare cu retry și clasificatorul `isConnectionError` (distinge „PostgreSQL e jos" de „query greșit"). |
| `groupSync.ts` | Puntea orar ↔ catalog. Legătura e **calculată pe nume** (`groupKey` = trimmed + lowercase), niciodată stocată. Tocmai pentru că legătura urmează numele, redenumirea unei grupe din catalog **se propagă în orarul de Profesor al proprietarului** (`renameLessonGroup`); altfel orele ar rămâne agățate de un nume pe care catalogul nu-l mai are, iar următoarea salvare a unei ore l-ar recrea ca a doua grupă, goală. Ștergerea unei grupe nu șterge ore. |
| `telegram.ts` | Stratul criptografic + transport: `validateInitData` (singura poartă de auth), `deriveWebhookSecret`, `safeEqual`, wrapper `fetch` peste Bot API cu timeout obligatoriu. Fără dependențe de Express sau DB. |
| `bot.ts` | Logica botului: `botReply` (pur, sincron) rutează comenzile românești `/azi`, `/saptamana`, `/rol`, `/notificari`, `/status`, `/help`; plus cele două moduri de operare, webhook și long polling. |
| `labels.ts` | Acordul numeralului în română („1 minut" / „5 minute" / „20 de minute"). |

### Suprafața API

| Grup | Rute |
|---|---|
| Sănătate | `GET /health`, `GET /api/health` — singurele fără auth |
| Profil | `GET /api/me`, `PATCH /api/me` |
| Orar | `GET /api/week`, `GET /api/non-working-days`, `GET /api/lessons`, `POST /api/lessons`, `PUT /api/lessons/:id`, `DELETE /api/lessons/:id` |
| Notificări | `GET /api/notifications`, `PATCH /api/notifications/read` |
| Catalog Profesor | `/api/teacher/*`: grupe (CRUD), studenți (CRUD), prezență (GET/POST), note (GET/POST) — **toate cer modul Profesor activ**, altfel 403 |
| Telegram | `POST /telegram/webhook` — autentificat prin secret token, nu prin `auth` |

`GET /api/week` e singura sursă de adevăr pentru numerotarea și paritatea săptămânii: întoarce și
semestrul curent, lista semestrelor configurate și zilele nelucrătoare ale săptămânii afișate.
Zilele nelucrătoare nu au rută de scriere — vezi „Zone fragile".

### Model de date

**SQLite (`orar.sqlite`)** — `profiles`, `lessons`, `delivered_reminders`, `notifications`,
`catalog_group_sync`, `non_working_days`, `non_working_seeds`

**PostgreSQL (catalog)** — `academic_groups` → `students` → (`attendance_sessions` → `attendance_entries`, `lab_grades`)

---

## 3. Frontend — `frontend/src/`

React 19 · Vite 6 · TypeScript · **fără router, fără state management** — o singură
pagină cu panouri modale. Texte în română cu diacritice.

| Fișier | Rol |
|---|---|
| `main.tsx` | Inițializează Telegram WebApp, importă CSS-urile, montează `<App/>` în StrictMode. |
| `App.tsx` | Inima aplicației: tot state-ul global (ore, notificări, rol, offset de săptămână, ziua activă, starea de sincronizare) și toate handler-ele de mutație. |
| `api.ts` | Singurul strat de rețea: `request()` cu timeout, antetul `X-Telegram-Init-Data`, `ApiError` cu erori pe câmpuri și mesaje românești per status, conversii `fromApi`/`toApi`. |
| `schedule.ts` | Aritmetica de calendar din interfață (ceas `Europe/Chisinau`, zile la 12:00 UTC, deci imună la DST) — **oglinda lui `backend/src/schedule.ts`**, inclusiv modelul de semestre. Calendarul nu mai poate fi dedus local: vine de la `GET /api/week` și e instalat cu `installSemesters`, care validează lista și cade înapoi pe `DEFAULT_SEMESTERS` dacă e goală sau nefolosibilă. Acel default local trebuie să rămână **identic** cu cel din backend, pentru că pe el rulează modul demo și secundele dinaintea primului răspuns. |
| `telegram.ts` | Adaptorul peste `window.Telegram.WebApp`: inițializare, detectarea modului de sesiune, `confirmAction` nativ, BackButton. |
| `dialogs.ts` | Hook-ul `useDialog`: stivă globală de modale, închidere cu Escape și cu BackButton-ul Telegram. |
| `types.ts` / `labels.ts` | Tipurile de domeniu și textele/pluralurile românești. |
| `components/LessonCard.tsx` | Cardul unei ore în lista zilei. |
| `components/LessonEditor.tsx` | Formularul modal de adăugare/editare, cu validare locală și maparea erorilor de câmp din backend. |
| `components/Panels.tsx` | `WeekNav` + trei panouri modale: notificări, calendar săptămânal, profil. |
| `components/TeacherCatalog.tsx` | Catalogul profesorului în două moduri: *settings* (grupe și studenți) și *records* (prezență pe ziua curentă, note de laborator). Cel mai mare fișier din frontend. |

**Invariantul cel mai important al proiectului:** frontend-ul și backend-ul trebuie să dea mereu
aceeași paritate pentru aceeași dată. De când semestrele sunt configurabile, invariantul are două
jumătăți, și amândouă trebuie verificate la orice modificare:

1. **Aceeași formulă** — `semesterAnchorOf` / `universityWeekNumber` / `weekTypeFor` din
   `frontend/src/schedule.ts` trebuie să rămână identice ca rezultat cu `anchorOf` /
   `universityWeekNumber` / `universityWeekKind` din `backend/src/schedule.ts`.
2. **Aceeași listă de semestre** — interfața o primește de la `GET /api/week`; `DEFAULT_SEMESTERS`
   din frontend trebuie să fie identic cu cel din backend, altfel modul demo și primele secunde de
   după deschidere arată altă paritate decât serverul.

---

## 4. Deploy

Există **două topologii paralele, cu același cod**.

### A. Generică / VPS — `docker-compose.yml` + Caddy

```
Internet :443 ──▶ Caddy (pe host) ──▶ 127.0.0.1:8083 ──▶ web (nginx :80)
                                                            │
                                            ┌───────────────┴──────────┐
                                            ▼                          ▼
                                    /api/*, /telegram/*           SPA static
                                            │
                                            ▼
                                       api (:3001)
                                       │         │
                              orar-data:/data   postgres:5432
                                 (SQLite)      (volum postgres-data)
```

Niciun port publicat pentru `api` și `postgres`. Singurul port expus este
`${WEB_BIND:-127.0.0.1}:${WEB_PORT:-8083}:80`. `docker-compose.dev.yml` adaugă, doar
local, `127.0.0.1:55434→5432` și `127.0.0.1:3001→3001`.

### B. serverhome — `deploy/serverhome/compose.yaml`

Imagini preconstruite `time-university-{api,web}:prod`, fără `build:`. Containerul
`time-university-web` e singurul din rețeaua externă `shared-network`, unde proxy-ul
partajat `nginx_proxy` îl atinge ca `http://time-university-web:80` după ce termină TLS
pentru `time-university.sma1lsoft.eu`. `api` și `db` rămân pe rețeaua `internal`, cu
bind-mounts sub `/srv/apps/time-university/`.

**Precondiție externă:** vhost-ul serverhome folosește `limit_req zone=perip` și
`limit_conn peripconn`, zone care trebuie definite în blocul `http{}` al proxy-ului
gazdă. Fără ele, `nginx -t` eșuează și reload-ul întregului proxy e blocat.

### Scripturi

`deploy/deploy.sh`, `deploy/backup.sh`, `deploy/serverhome/{build,deploy,backup}.sh` —
toate cu `set -euo pipefail`, variabile ghilimelate, `trap` de cleanup, validare `-s` pe
dump-uri, `SHA256SUMS` și retenție pe dată.

---

## 5. Securitate — cum se ține aplicația

| Strat | Mecanism |
|---|---|
| Autentificare | `initData` semnat de Telegram, verificat cu `HMAC_SHA256(HMAC_SHA256("WebAppData", botToken), checkString)`, comparație timing-safe, fereastră de prospețime pe `auth_date`. |
| Autorizare | Totul e filtrat pe `owner_id` — orarul, notificările, grupele; studenții, prezența și notele prin join pe `academic_groups.owner_id`. |
| Webhook | Secret token `X-Telegram-Bot-Api-Secret-Token`, comparat timing-safe. |
| Rate limiting | Pe IP la intrarea în `/api`, pe id-ul Telegram în `auth`. |
| Injecție SQL | Zero — toate query-urile sunt parametrizate; singurele interpolări sunt constante de cod. |
| Injecție în mesaje | Botul nu folosește `parse_mode` deloc, deci un nume de utilizator nu poate injecta formatare. |
| Headere | helmet pe API; CSP cu `frame-ancestors` pentru Telegram, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `server_tokens off` în nginx. |

---

## 6. Cum se rulează

```bash
# backend
cd backend && npm install && npm run dev      # tsx watch
cd backend && npx vitest run                  # teste
cd backend && npx tsc -p tsconfig.json --noEmit

# frontend
cd frontend && npm install && npm run dev
cd frontend && npx tsc -b && npx eslint . --max-warnings=0

# stiva completă
docker compose up --build -d
```

Testele de catalog cer PostgreSQL: fără `DATABASE_URL_TEST` ele sunt **sărite**, nu
eșuate. Asta înseamnă că logica de catalog e cea mai puțin acoperită zonă a proiectului
— e locul unde regresiile trec cel mai ușor neobservate.

---

## 7. Zone fragile — unde să te uiți întâi când ceva se strică

1. **Paritatea săptămânilor** — *reparat:* semestrele se configurează din `SEMESTERS`, iar paritatea
   și numerotarea repornesc la fiecare semestru, deci vacanța nu mai consumă paritate. Punctul fragil
   rămas: variabila e o **configurație de mediu** — dacă nu e completată la timp cu semestrele reale,
   se folosește semestrul implicit, fără sfârșit, și tot ce urmează după el e extrapolare. Verifică-o
   la începutul fiecărui an universitar și confirmă cu `GET /api/week`.
2. **Legătura orar ↔ catalog pe nume** — *reparat:* redenumirea unei grupe se propagă acum în orarul
   de Profesor (`renameLessonGroup`), deci nu mai apare a doua grupă goală cu numele vechi. Punctul
   fragil rămas: legătura e tot **calculată pe nume**, deci o oră editată manual cu alt nume de grupă
   se dezleagă tăcut de grupa din catalog.
3. **Zile libere** — *reparat:* `non_working_days` + `non_working_seeds`, cu sărbătorile legale ale
   Moldovei semănate automat pentru anul curent și următorul (inclusiv cele mobile, din Paștele
   ortodox), plus zilele adăugate manual; perioadele din afara semestrelor sunt nelucrătoare prin
   construcție. Orele rămân vizibile, tac doar memento-urile. Punctul fragil rămas: **nu există rută
   de scriere** — aplicația nu are model de administrator (orice utilizator autentificat primește
   ambele moduri), iar o zi nelucrătoare ar amuți memento-urile tuturor, deci ar fi un denial of
   service dintr-o singură cerere. Adăugarea/ștergerea se face pe server, cu `setNonWorkingDay` /
   `removeNonWorkingDay` din `db.ts`.
4. **Catalogul PostgreSQL** — testele lui sunt sărite implicit; rulează-le cu `DATABASE_URL_TEST`
   înainte de orice modificare acolo.
5. **Cele două `schedule.ts`** — orice divergență între frontend și backend produce ore
   afișate în săptămâna greșită.
