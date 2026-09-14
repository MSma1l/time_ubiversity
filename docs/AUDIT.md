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

Teste backend: de la **2** la **45** (8 fișiere). Frontend lint: **0** warning-uri.

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

- Backend: build + **45 teste** trecute.
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
| D1 | Prezența nu se reîncarcă la redeschiderea catalogului. | Backend-ul nu are endpoint de citire a prezenței; profesorul nu vede ce a salvat anterior. |
| D3 | Memento-urile din nopțile de schimbare a orei (DST) pot fi decalate cu o oră. | Rar, de două ori pe an. |
| D4 | Offset-ul de polling Telegram nu este persistat. | După un crash, un update poate fi procesat de două ori. |
| D5 | Oricine își poate alege rolul Profesor. | By design; datele catalogului sunt izolate per proprietar. |
| D6 | Scriptul Telegram (`telegram-web-app.js`) injectează un `<style>` inline în Telegram Web. | Nu este blocat: CSP-ul actual din `frontend/nginx.conf` permite `'unsafe-inline'` la `style-src`. Compromis acceptat; eliminarea lui ar necesita hash-uri/nonce pentru stiluri. |
| D7 | `createdAt` al notificărilor este salvat fără fus orar. | Tratat în frontend la afișare; ideal ar fi ISO cu offset din backend. |
| D8 | Nu există endpoint-uri pentru ștergerea grupelor/studenților sau citirea notelor. | Funcționalitate de adăugat ulterior. |
| D9 | Comanda bot `/notificari on\|off` suprascrie setarea fiecărei lecții. | Alegerile per lecție se pierd la folosirea comenzii. |
| D10 | Rate limit-ul este în memorie. | Corect pentru o singură instanță `api`; la scalare orizontală ar trebui Redis. |
