# Raport de audit — Orar Univer

Audit de securitate, corectitudine și operare pentru Telegram Bot + Mini App
(backend Node 22 / TypeScript / Express 5 + SQLite + PostgreSQL; frontend React 19 + Vite + nginx;
Docker Compose). Documentul descrie problemele găsite și reparate, ce a fost verificat efectiv și
ce rămâne deschis.

**Severitate:** **Înalt** — risc de securitate, pierdere de date sau funcție de bază stricată ·
**Mediu** — comportament greșit, robustețe sau hardening lipsă · **Scăzut** — detalii, calitate.

## Sumar

| Zonă | Înalt | Mediu | Scăzut |
|---|---|---|---|
| Backend | 5 | 7 | 2 |
| Frontend | 4 | 6 | — |
| Infrastructură | 2 | 4 | — |

Teste backend: de la 2 teste la o suită care acoperă config, validare, API, bot, memento-uri și
catalog (`npm test --prefix backend`; numărul crește la fiecare sesiune, de aceea nu e fixat aici).
Frontend lint: **0** warning-uri.

## 1. Backend (reparat)

### Înalt

| # | Problemă | Reparare |
|---|---|---|
| B1 | `/telegram/webhook` accepta update-uri false fără niciun secret: oricine putea schimba rolul sau notificările oricărui utilizator. | Cere antetul `X-Telegram-Bot-Api-Secret-Token` (comparație în timp constant); endpoint-ul este dezactivat (404) în modul polling; `setWebhook` se face automat cu secretul. |
| B2 | Pool-ul PostgreSQL nu avea listener pentru `'error'` → procesul cădea la restartul Postgres. | Listener adăugat; procesul nu mai cade când Postgres repornește. |
| B3 | Memento-uri duplicate sau pierdute: trimiterea era înregistrată după expediere și se verifica doar minutul exact. | Înregistrare înainte de trimitere, fereastră de recuperare de 5 minute, retry doar pe erori temporare. |
| B4 | Memento-urile pentru orele imediat după miezul nopții nu se trimiteau. | Calculul trece corect peste schimbarea zilei. |
| B5 | Cu `MINI_APP_URL` pe `http`, memento-urile eșuau (Telegram respinge butonul `web_app`). | Butonul este adăugat doar pentru URL `https://`; mesajul pleacă oricum. |

### Mediu

| # | Problemă | Reparare |
|---|---|---|
| B6 | Prezență: profesorul putea marca studenți din grupa altui profesor; ID-uri necunoscute → 500. | Tranzacție + verificarea apartenenței studenților la grupa proprietarului. |
| B7 | JSON invalid, ID non-UUID sau grupă duplicat dădeau 500. | Răspunsuri corecte 400 / 404 / 409. |
| B8 | Schema catalogului PostgreSQL era inițializată la fiecare cerere, cu curse. | O singură inițializare, cu lock + retry. |
| B9 | Polling Telegram fără timeout, backoff sau tratarea conflictului 409. | Timeout, backoff, tratare explicită a conflictului 409 (log + reîncercare mai târziu). |
| B10 | Lipseau: oprire grațioasă la SIGTERM, 404 JSON, handler pentru erori neprinse, validarea env la pornire, rate limiting, `trust proxy`. | Toate adăugate: fail-fast în producție cu lista problemelor de configurare; limitare per IP și per utilizator. |
| B11 | `/api/week?date=2026-13-45` răspundea cu `number: null`. | Data invalidă → 400. |
| B12 | Botul folosea `chat.id` în loc de `from.id` și răspundea în grupuri. | Identificare după `from.id`; răspunde doar în chat privat. |

### Scăzut

| # | Problemă | Reparare |
|---|---|---|
| B13 | Verificarea `initData`: sortare dependentă de locale; `auth_date` în viitor acceptat până la 24h. | Sortare deterministă; toleranță pentru ceas de maxim 60 s. |
| B14 | Diverse detalii de calitate și robustețe. | `studentEnabled`/`teacherEnabled` 0/1 → boolean; limite (500 lecții/utilizator, 200 grupe, 500 studenți/grupă); caractere de control respinse; `busy_timeout` + indexuri SQLite; curățare zilnică; testele nu mai intră în `dist`. |

## 2. Frontend (reparat)

### Înalt

| # | Problemă | Reparare |
|---|---|---|
| F1 | Editorul trimitea mereu `endTime` 09:30 → orele care încep la 09:30 sau mai târziu eșuau la salvare. | Câmp nou pentru ora de final. |
| F2 | Salvarea prezenței suprascria toți ceilalți studenți ca „prezenți"; data era în UTC, nu în ora Chișinăului. | Nu mai sunt suprascriși ceilalți studenți; data calculată în `Europe/Chisinau`. |
| F3 | Anularea prompt-ului de notă salva nota 0. | Input inline cu valori 0–10. |
| F4 | Date demo („Alex") afișate în producție când lipsea Telegram sau eșua încărcarea; modificările se pierdeau. | Demo doar pe serverul de dezvoltare Vite sau cu `VITE_DEMO_MODE=true`; altfel mesaj de eroare cu butonul „Reîncearcă". |

### Mediu

| # | Problemă | Reparare |
|---|---|---|
| F5 | Paritatea săptămânii folosea fusul orar al dispozitivului. | Calcul în `Europe/Chisinau`. |
| F6 | „Următoarea oră" ignora schimbarea parității săptămânii. | Ține cont de paritate. |
| F7 | Sâmbăta era invizibilă în tab-uri și calendar; orele nestandard (ex. 13:15) lipseau din calendar. | Afișate corect. |
| F8 | Datele notificărilor erau parsate greșit pe Safari/iOS. | Parsare compatibilă. |
| F9 | Erori API fără mesaje în română, fără timeout, posibil dublu-submit. | Mesaje în română, timeout, protecție la dublu-submit. |
| F10 | Probleme React: closures învechite, răspunsuri întârziate aplicate grupei greșite, update-uri de state în timpul render. | Reparate. |

Alte îmbunătățiri: lint stricat (lipsea `eslint.config.js`) → reparat, 0 warning-uri; integrare
Telegram (BackButton, confirmare nativă, culorile temei); accesibilitatea dialogurilor; limite de
lungime pe câmpuri; eliminat `@twa-dev/sdk` nefolosit; `App.tsx` împărțit în componente
(`frontend/src/components/`).

## 3. Infrastructură (reparat)

### Înalt

| # | Problemă | Reparare |
|---|---|---|
| I1 | Parola PostgreSQL `change-me` era hardcodată în `docker-compose.yml`. | Citită obligatoriu din `.env` din rădăcină (`POSTGRES_PASSWORD`); `deploy.sh` refuză valoarea `change-me`. |
| I2 | PostgreSQL (55434) și API (3001) erau publicate pe toate interfețele. | Nepublicate în producție; doar `web` publicat, pe `127.0.0.1` (`WEB_BIND`). Porturile de debug există doar în `docker-compose.dev.yml`, legate la `127.0.0.1`. |

### Mediu

| # | Problemă | Reparare |
|---|---|---|
| I3 | Containerul `api` rula ca root. | Utilizator `node`, `tini` ca PID 1, `/data` deținut de `node` (repararea volumelor vechi în `deploy.sh`). |
| I4 | Frontend fără `.dockerignore`. | Adăugat. |
| I5 | nginx rezolva IP-ul `api` o singură dată → 502 permanent după recrearea containerului. | `resolver 127.0.0.11 valid=10s` + `proxy_pass` prin variabilă. |
| I6 | Lipseau gzip, cache pentru `/assets`, antete de securitate aplicate corect (moștenirea `add_header` le pierdea), `X-Forwarded-*`, `server_tokens off`, limite de body. | Toate configurate în `frontend/nginx.conf` (antetele doar la nivel de `server`, variații prin `map`). |

Compose: rotație loguri (10 MB × 5), limite de memorie, `no-new-privileges`, `start_period` la
healthcheck-uri. Fișiere noi: `deploy/deploy.sh`, `deploy/backup.sh` (`pg_dump` + SQLite `.backup`
+ `SHA256SUMS` + retenție; portabil `sha256sum`/`shasum`), `deploy/Caddyfile` (HTTPS),
`docker-compose.dev.yml`, `.gitignore`, `.env.example`.

## 3b. Al doilea val de reparații

| # | Sev. | Problemă | Reparație |
|---|---|---|---|
| V1 | Mediu | Editarea unei ore trimitea mereu `notificationsEnabled: true` → reactiva memento-urile oprite. | Frontend-ul păstrează valoarea reală a lecției. |
| V2 | Mediu | Editorul nu avea câmp pentru `reminderMinutes`; textul „15 minute" de pe ecranul principal era fix. | Câmp „Memento" (Fără / 5 / 10 / 15 / 30 / 60 min); textul reflectă setările reale. |
| V3 | Mediu | Orele de duminică (acceptate de backend) nu apăreau; duminica niciun tab nu era activ. | Tab-uri Luni–Duminică, Duminică în editor, coloană în calendar doar dacă există ore. |
| V4 | Mediu | Memento cu `reminderMinutes = 0` nu avea fereastră de recuperare (un tick ratat = memento pierdut). | Fereastră de 5 min pentru toate memento-urile, verificare ieri/azi/mâine; 3 teste noi. |
| V5 | Scăzut | `academic.ts` citea direct `process.env.DATABASE_URL`, ignorând `config`. | Folosește `config.databaseUrl`. |
| V6 | Scăzut | Nota (`NUMERIC`) era returnată ca text. | `grade::float8` → număr. |
| V7 | Scăzut | Textul butonului diferea („Deschide Orarul" / „Deschide orarul"). | Unificat. |

## 4. Ce a fost verificat

Verificări rulate efectiv:

- Backend: build + suita Vitest completă (`npm test --prefix backend`), toate testele trecute.
- Frontend: lint (0 warning-uri) + build reușit.
- Imaginile Docker construite; stack pornit izolat — `postgres`, `api`, `web` toate `healthy`.
- `/api/health` OK; cerere fără autentificare → 401; webhook fără secret → 401.
- Antetele CSP și `Cache-Control` prezente în răspunsurile nginx.
- Test cap-coadă cu `initData` semnat:
  - profil; CRUD lecții; alt utilizator primește 404 la lecția altcuiva; validare → 400;
  - `/api/week` paritate: 10 sept 2026 → pară, 14 sept 2026 → impară;
  - grupă creată 201 / duplicat 409; student adăugat; prezență 204; notă 201;
  - acces străin la grupă → 404.
- Restart `api` cu SIGTERM: oprire curată, date persistente.
- Containerul `api` rulează cu uid `node`.
- `deploy/backup.sh` rulat cu succes, checksum-uri verificate.

**NU a fost verificat:** rularea reală în Telegram cu un token real, HTTPS real prin Caddy,
webhook real înregistrat la Telegram.

## 5. Rămân deschise

| # | Problemă | Impact / notă |
|---|---|---|
| D1 | ~~Prezența nu se reîncarcă la redeschiderea catalogului.~~ | **Rezolvat** (valul 3): există `GET /api/teacher/groups/:groupId/attendance`; prezența salvată se revede la redeschidere. |
| D3 | Memento-urile din nopțile de schimbare a orei (DST) pot fi decalate cu o oră. | Rar, de două ori pe an. |
| D4 | Offset-ul de polling Telegram nu este persistat. | După un crash, un update poate fi procesat de două ori. |
| D5 | Oricine își poate alege rolul Profesor. | By design; datele catalogului sunt izolate per proprietar. |
| D6 | Scriptul Telegram (`telegram-web-app.js`) injectează un `<style>` inline în Telegram Web. | Nu este blocat: CSP-ul actual din `frontend/nginx.conf` permite `'unsafe-inline'` la `style-src`. Compromis acceptat; eliminarea lui ar necesita hash-uri/nonce pentru stiluri. |
| D7 | `createdAt` al notificărilor este salvat fără fus orar. | Tratat în frontend la afișare; ideal ar fi ISO cu offset din backend. |
| D8 | ~~Nu există endpoint-uri pentru ștergerea grupelor/studenților sau citirea notelor.~~ | **Rezolvat** (valul 3): `DELETE`/`PATCH` pe grupe și studenți, `GET` pe note. |
| D9 | ~~Comanda bot `/notificari on\|off` suprascrie setarea fiecărei lecții.~~ | **Rezolvat** (valul 3): comanda comută doar `profiles.reminders_enabled`; setările per lecție rămân intacte. |
| D10 | Rate limit-ul este în memorie. | Corect pentru o singură instanță `api`; la scalare orizontală ar trebui Redis. |

## 6. Salvarea orarului și separarea Student / Profesor

Plângere: „orarul nu se salvează; ca Student și ca Profesor trebuie să am orare diferite”.
În producție (versiunea veche): `POST /api/lessons 400`.

**Cauza erorii 400 (versiunea veche, `Orar-Univer-Docker.zip`):** editorul trimitea mereu
`endTime: existing?.endTime ?? '09:30'` (nu avea câmp pentru ora de final). Orice oră nouă care
începea la 09:30 sau mai târziu era respinsă de backend (`endTime > startTime`), iar mesajul de
eroare era ascuns. Tot acolo, `PUT` trimitea rolul *activ* în loc de rolul lecției. Codul actual
are câmp de final, validare locală și trimite rolul lecției — eroarea nu mai apare.

| # | Problemă găsită în codul actual | Reparare |
|---|---|---|
| S1 | Erorile de salvare/ștergere apăreau în notificarea din spatele editorului (modal) — utilizatorul nu vedea de ce „nu se salvează”. | Editorul afișează mesajul serverului și marchează câmpurile respinse (`aria-invalid` + text sub câmp); mesajele zod ale lecțiilor sunt în română. |
| S2 | Grupa era obligatorie în editor, deși backend-ul o acceptă goală. | Grupa este opțională. |
| S3 | O oră pară/impară salvată în săptămâna cealaltă „dispărea” din listă. | După salvare se selectează ziua lecției, iar mesajul spune în ce săptămâni apare. |
| S4 | Rolul unei ore noi era citit la salvare; o schimbare de rol cu editorul deschis o muta în celălalt orar. | Rolul se fixează la deschiderea editorului; `PUT` fără `role` păstrează rolul existent. |
| S5 | Notificările și contorul erau comune ambelor roluri; botul `/azi`, `/saptamana` amesteca orele. | `notifications.role` (null = general); contor/listă/marcare citite pe rolul activ; botul arată orarul rolului activ. |
| S6 | Ore în format `9:30` / `09:30:00` (unele WebView-uri) → 400 sau comparație greșită. | Normalizare la `HH:MM` în frontend, backend și migrare. |
| S7 | Baze vechi fără coloane `role` etc. sau cu valori nevalide ar fi dat 500 / ore invizibile. | Migrare idempotentă: coloane lipsă adăugate, roluri/săptămâni/ore normalizate (implicit Student). |

Verificat: scenariu UI în Chrome headless (dev auth) — creare/editare/ștergere ca Student și
Profesor, 08:00/09:30/13:15/18:00, pară/impară/fiecare, câmpuri opționale goale, memento oprit,
reîncărcare: toate persistă și rămân separate; DB creată cu schema veche se deschide cu orele
vizibile în rolul corect.

## 7. Al treilea val de reparații

| Zonă | Reparație |
|---|---|
| Săptămâni | Navigare ‹ › între săptămâni (dată + paritate), „Azi”; orele de paritate opusă se văd, se editează și se șterg; duminică „Lu” duce la ziua de mâine. |
| Sesiune | Schimbarea rolului/modurilor cu sesiune expirată (401/409) se anulează și afișează eroarea; rolul activ nu poate fi un mod dezactivat. |
| Profil (backend) | Regulă unică în `profile.ts` pentru API și bot: minim un mod activ, rolul doar pe un mod activ (409); migrare care repară profilele. |
| Bot | `/notificari on/off` comută doar `reminders_enabled` din profil (nu mai suprascrie lecțiile); mesaje de utilizare; `setMyCommands`; numele „Orar Univer”. |
| Memento-uri | Gramatică corectă („20 de minute”, „1 minut”) prin `labels.ts`. |
| Catalog | GET prezență și note (se văd după redeschidere); notă unică per laborator (upsert); nume de grupă unice fără diferență de majuscule; redenumire/ștergere grupe și studenți; 503 când Postgres cade, 400 pentru date invalide; layout mobil cu tastatură. |
| Notificări | Reîncărcate la deschiderea panoului și la revenirea în aplicație. |

Teste backend: suita completă trecută (testele de catalog rulează doar cu `DATABASE_URL_TEST`,
altfel sunt sărite). Frontend: lint 0 warning-uri, build OK.

## 8. Al patrulea și al cincilea val — constatări anterioare închise

Tabelul păstrează constatarea așa cum a fost formulată și adaugă starea ei de acum, ca să se vadă
evoluția. Reparațiile sunt verificabile în fișierele indicate.

| # | Constatarea anterioară | Starea actuală |
|---|---|---|
| A1 | Paritatea săptămânii pornea de la o **ancoră unică hardcodată în cod** (`2026-09-07`, pară), cu un contor care curgea la infinit: vacanța de iarnă consuma paritate, deci semestrul II putea ieși inversat, iar anul universitar următor era pură extrapolare. | **Rezolvat.** Semestrele se citesc din variabila `SEMESTERS` (`START:even\|odd[:END]`, separate prin virgulă), validată la pornire în `config.ts` / `schedule.ts`: `START` trebuie să fie luni, `END` e inclusiv și poate lipsi doar la ultima intrare, semestrele nu se pot suprapune. **Paritatea și numerotarea repornesc la fiecare semestru.** Valoarea goală păstrează exact comportamentul dinainte. Rămâne o sarcină de operare: variabila trebuie completată la începutul fiecărui an universitar (`docs/DEPLOY.md`, 3.3). |
| A2 | **Noțiunea de zi liberă nu exista**: cron-ul trimitea memento-uri și de 1 Mai, și în vacanța de vară. | **Rezolvat.** Două tabele noi în SQLite (`non_working_days`, `non_working_seeds`): sărbătorile legale ale Moldovei sunt semănate automat pentru anul curent și următorul — cele cu dată fixă și cele mobile, derivate din Paștele ortodox calculat (`orthodoxEaster`) — iar administratorul poate adăuga zile pe server. Semănatul e idempotent de două ori (anul e notat în `non_working_seeds`, inserarea e `INSERT OR IGNORE`), deci o sărbătoare ștearsă intenționat nu reapare. Perioadele din afara semestrelor sunt nelucrătoare prin construcție, fără să fie enumerate. Comportament: **orele rămân vizibile, tac doar memento-urile.** |
| A3 | `profile.timezone` era **câmp mort**: returnat de `GET /api/me`, nefolosit de nimic. | **Rezolvat.** Scos din model (`profile.ts`) și din răspunsul API (`publicProfile` listează explicit câmpurile expuse, ca o coloană internă să nu mai poată scăpa în răspuns). Motivul e de fond: orarul e al universității, deci un student aflat în altă țară tot la ora Chișinăului are cursul — un fus personal ar produce memento-uri la ora greșită. Coloana veche rămâne în bazele existente, inofensivă, pentru că nu mai e citită. |
| A4 | Redenumirea unei grupe în catalog **nu atingea orarul**: legătura fiind pe nume, orele rămâneau agățate de numele vechi, iar următoarea salvare a unei ore recrea numele vechi ca **a doua grupă, goală**. | **Rezolvat.** `PATCH /api/teacher/groups/:groupId` redenumește grupa și în orarul de Profesor al proprietarului (`renameLessonGroup`), inclusiv când se schimbă doar majusculele. Ordinea scrierilor e aleasă intenționat: SQLite se redenumește în interiorul tranzacției PostgreSQL, chiar înainte de COMMIT — un eșec pe SQLite face rollback la catalog (nu se schimbă nimic nicăieri), iar dacă eșuează doar COMMIT-ul, repetarea aceleiași cereri repară situația. Ordinea inversă n-ar fi fost reparabilă: numele vechi ar fi dispărut din catalog și nicio cerere n-ar mai fi găsit orele. |
| A5 | **TOCTOU pe limite**: `COUNT` și `INSERT` erau separate de `await`-uri, deci două cereri paralele ale aceluiași profesor, la `limită − 1`, treceau amândouă de verificare și depășeau limita de grupe / de studenți. | **Rezolvat.** Scrierile sunt serializate cu advisory lock-uri PostgreSQL pe tranzacție: `lockOwnerCatalog` (scrierile de catalog ale unui proprietar — creare, redenumire, sincronizarea din orar) și `lockCatalogGroup` (crearea de studenți într-o grupă). Namespace-urile sunt fixe și disjuncte, iar o tranzacție ia cel mult unul și nu apelează cod care ar lua altul, deci nu se pot bloca reciproc. |
| A6 | Imaginile de bază erau **nefixate**: două build-uri ale aceluiași commit puteau produce straturi diferite, iar un rollback nu era reproductibil. | **Rezolvat.** `node:22-alpine`, `nginx:1.27-alpine` și `postgres:16-alpine` sunt fixate pe digest-ul **manifestului multi-arhitectură** în `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml` și `deploy/serverhome/compose.yaml`. Compromisul asumat: `docker build --pull` nu mai aduce singur patch-urile de securitate ale imaginii de bază, deci digest-urile se ridică manual, lunar — procedura completă (cum se află digest-ul, cum se verifică înainte de a-l scrie, ce se controlează după deploy) e în `docs/DEPLOY.md`, secțiunea 9.1. |
| A7 | Fereastra de acceptare `initData` era de **24 de ore**. | **Rezolvat.** Implicit **1 oră** (`INIT_DATA_MAX_AGE_SECONDS`, interval acceptat 60..604800). `initData` e o credențială de tip bearer, fără mecanism de revocare, deci fereastra de replay stă scurtă. |
| A8 | Rutele `/api/teacher/*` erau accesibile oricărui utilizator autentificat; apartenența la modul Profesor era doar o convenție de interfață. | **Rezolvat.** Un middleware montat pe `/api/teacher` cere `teacherEnabled` în profil și răspunde **403** altfel — regula e impusă pe server, nu în interfață. Izolarea pe `owner_id` de la fiecare interogare rămâne neschimbată. |
| A9 | Cheia de deduplicare a memento-urilor includea și ora ocurenței, deci **mutarea orei re-arma un memento deja trimis** în aceeași zi. | **Rezolvat.** Cheia e acum **doar data** (`YYYY-MM-DD`): o lecție are o singură oră de început pe zi, deci editarea ei nu mai poate declanșa un al doilea mesaj. Formatul păstrează valabilă și comparația cu pragul de curățare din `pruneDatabase`. |
| A10 | `deploy/serverhome/compose.yaml` folosea `env_file: .env`, deci împingea în containerul API tot fișierul, inclusiv `POSTGRES_PASSWORD`, pe care API-ul nu-l citește niciodată și pe care `docker inspect` îl expunea. | **Rezolvat.** Serviciul `api` are o listă explicită de variabile sub `environment:`, alimentată tot din același `.env` prin interpolare. Costul, documentat acum în `deploy/serverhome/README.md`: **o variabilă nouă a aplicației trebuie adăugată în două locuri** (`.env.example` și lista din `compose.yaml`), altfel nu ajunge în container. |

Verificat pentru acest val: `docker compose -f deploy/serverhome/compose.yaml config -q` trece, iar
`SEMESTERS` apare în mediul rezolvat al serviciului `api` (cu virgulele intacte).
