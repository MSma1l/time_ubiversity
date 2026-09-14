# Deploy în producție — Orar Univer

Ghid pas cu pas pentru un VPS Ubuntu nou. Rezultatul final:

```
Internet ──HTTPS──> Caddy (host, :443) ──> 127.0.0.1:8083 ──> web (nginx) ──> api:3001 ──> postgres:5432
                                                                               └─> SQLite (volum /data)
```

Doar containerul `web` publică un port, legat implicit la `127.0.0.1`. Postgres și API nu sunt
accesibile din exterior. Pentru dezvoltare locală există `docker-compose.dev.yml` (niciodată pe VPS).

## 1. Cerințe

- VPS Ubuntu cu acces `sudo` (min. ~1 GB RAM; limitele de memorie din compose: 512m + 512m + 128m).
- Un domeniu (ex. `orar.exemplu.md`) cu înregistrare **DNS A** (și AAAA dacă ai IPv6) către IP-ul VPS.
- Porturile **80** și **443** deschise (Caddy obține certificatul Let's Encrypt prin ele).
- Token de bot de la **@BotFather**.
- Docker Engine + pluginul **docker compose v2** (verificat de `deploy/deploy.sh`).

## 2. Instalare Docker, Caddy și codul aplicației

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # apoi deloghează-te și reloghează-te
docker compose version               # trebuie să răspundă (v2)

sudo apt install -y caddy git

sudo mkdir -p /opt/orar-univer && sudo chown "$USER": /opt/orar-univer
git clone <URL-repository> /opt/orar-univer
cd /opt/orar-univer
```

> Numele directorului contează: volumele Docker se numesc `<nume-director>_orar-data` și
> `<nume-director>_postgres-data`. Vezi secțiunea „Migrare" dacă ai deja o instalare.

## 3. Configurare

### 3.1 `.env` (rădăcina proiectului — variabile pentru Docker Compose)

```bash
cp .env.example .env
openssl rand -hex 24                 # copiază rezultatul în POSTGRES_PASSWORD
nano .env
```

| Variabilă | Valoare | Note |
|---|---|---|
| `POSTGRES_PASSWORD` | ieșirea `openssl rand -hex 24` | **Obligatorie.** Doar caractere URL-safe (`A-Z a-z 0-9 . _ ~ -`), e inclusă în `DATABASE_URL`. `deploy.sh` refuză `change-me`. |
| `POSTGRES_USER` / `POSTGRES_DB` | `orar` / `orar` | Implicite. |
| `WEB_PORT` | `8083` | Trebuie să coincidă cu portul din `deploy/Caddyfile`. |
| `WEB_BIND` | `127.0.0.1` | Păstrează-l așa în producție. |
| `COMPOSE_PROJECT_NAME` | (opțional) | Fixează numele volumelor dacă muți directorul. |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` | (opțional) `./backups`, `14` | Folosite de `deploy/backup.sh`. |

Parola Postgres se aplică **doar la crearea volumului**. Pentru a o schimba pe un volum existent:
`docker compose exec postgres psql -U orar -d orar -c "ALTER USER orar PASSWORD '<noua>';"`

### 3.2 `backend/.env` (secretele aplicației)

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

| Variabilă | Valoare în producție |
|---|---|
| `TELEGRAM_BOT_TOKEN` | tokenul de la @BotFather (obligatoriu) |
| `MINI_APP_URL` | `https://orar.exemplu.md` (trebuie `https://`, altfel `deploy.sh` eșuează) |
| `ALLOWED_ORIGINS` | `https://orar.exemplu.md` (fără `/` final; mai multe origini separate prin virgulă) |
| `ALLOW_DEV_AUTH` | `false` (cu `true` API-ul refuză să pornească în producție) |
| `INIT_DATA_MAX_AGE_SECONDS` | `86400` implicit (60..2592000) |
| `RATE_LIMIT_PER_MINUTE` | `120` implicit (`0` dezactivează) |
| `TRUST_PROXY` | lasă valoarea implicită `loopback, linklocal, uniquelocal` |

`NODE_ENV=production`, `PORT=3001`, `DATABASE_PATH=/data/orar.sqlite` și `DATABASE_URL` sunt
**forțate de `docker-compose.yml`** și suprascriu ce scrii în `backend/.env`.

**Modul de primire a update-urilor — alege EXACT UNUL:**

- **Polling** (cel mai simplu): `TELEGRAM_POLLING=true`, `WEBHOOK_URL=` gol.
  La pornire API-ul șterge automat orice webhook activ.
- **Webhook**:
  ```ini
  TELEGRAM_POLLING=false
  WEBHOOK_URL=https://orar.exemplu.md/telegram/webhook
  TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
  ```
  API-ul apelează singur `setWebhook`; cererile fără antetul corect
  `X-Telegram-Bot-Api-Secret-Token` primesc 401.

## 4. Pornire

```bash
./deploy/deploy.sh
```

Scriptul este idempotent: verifică `.env` și `backend/.env`, rulează `docker compose config`,
construiește imaginile (`build --pull`), repară proprietarul fișierelor din volumul `/data`
(utilizatorul `node`), pornește stack-ul, așteaptă `healthy` pentru `postgres`, `api`, `web`,
verifică `http://127.0.0.1:8083/` și curăță imaginile vechi.

| Opțiune | Efect |
|---|---|
| `--pull` | `git pull --ff-only` înainte de deploy |
| `--no-build` | pornește cu imaginile existente |
| `--timeout SECUNDE` | cât așteaptă containerele sănătoase (implicit 180) |

## 5. HTTPS cu Caddy

```bash
sed 's/orar.example.md/orar.exemplu.md/' deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Caddyfile face proxy către `127.0.0.1:8083` (schimbă-l dacă ai alt `WEB_PORT`), adaugă HSTS,
compresie, health check pe `/nginx-health` și loguri în `/var/log/caddy/orar-access.log` (rotite).

## 6. Firewall (ufw)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Nu deschide 8083, 3001 sau 5432 — nu sunt necesare (și nu sunt publicate pe interfețe externe).

## 7. Configurare @BotFather

1. `/mybots` → botul tău → **Bot Settings** → **Menu Button** → URL: `https://orar.exemplu.md`.
2. Opțional, **Configure Mini App** → Web App URL: `https://orar.exemplu.md`.

Butoanele „Deschide" din `/start` și din memento-uri folosesc `MINI_APP_URL` (doar dacă e `https`).

## 8. Verificare

```bash
curl https://orar.exemplu.md/api/health
# {"ok":true,"status":"ok","sqlite":"ok","postgres":"ready"}
docker compose ps          # postgres, api, web: (healthy)
```

`"status":"degraded"` cu `"postgres":"connecting"` este normal câteva secunde după pornire;
cu `"postgres":"error"` vezi depanarea. Apoi deschide botul în Telegram, `/start`, butonul de meniu.

## 9. Operare

**Actualizări:**
```bash
cd /opt/orar-univer && ./deploy/deploy.sh --pull
```

**Loguri:**
```bash
docker compose logs -f api            # sau postgres / web
docker compose logs --tail=100 api
```
Rotația este deja configurată în compose (`json-file`, 10 MB × 5 fișiere per container).

**Backup zilnic** (`pg_dump` format custom + backup online SQLite + `SHA256SUMS`, retenție 14 zile):
```bash
mkdir -p /opt/orar-univer/backups      # necesar: cron redirecționează logul acolo
./deploy/backup.sh                     # test manual → backups/AAAA-LL-ZZ_HHMMSS/
crontab -e
# 15 3 * * * cd /opt/orar-univer && ./deploy/backup.sh >> backups/backup.log 2>&1
```
Utilizatorul crontab-ului trebuie să aibă acces la Docker (grupul `docker`). Copiază periodic
`backups/` în afara VPS-ului. Verificare integritate: `cd backups/<ts> && sha256sum -c SHA256SUMS`.

**Restaurare** (înlocuiește `<ts>` cu directorul backup-ului):
```bash
# PostgreSQL (catalogul Profesor)
docker compose exec -T postgres pg_restore -U orar -d orar --clean --if-exists < backups/<ts>/postgres.dump

# SQLite (profiluri, orar, notificări)
docker compose stop api
docker compose run --rm --no-deps -T --user root -v "$PWD/backups/<ts>:/restore:ro" --entrypoint sh api \
  -c 'gunzip -c /restore/orar.sqlite.gz > /data/orar.sqlite && rm -f /data/orar.sqlite-wal /data/orar.sqlite-shm && chown node:node /data/orar.sqlite'
docker compose start api
```

## 10. Migrare de la versiunea veche (IMPORTANT)

Versiunea veche avea în compose parola `change-me` hardcodată, containerul `api` rulând ca root și
porturile 3001, 55434 și 8083 publicate pe toate interfețele.

1. **Fă backup înainte** (sau cel puțin `docker compose exec -T postgres pg_dump -U orar -d orar -Fc > vechi.dump`).
2. **Același director** (ex. rămâi în directorul vechi) sau setează `COMPOSE_PROJECT_NAME=<numele-vechi>`
   în `.env` — altfel Compose creează volume **noi, goale** (`<dir>_orar-data`, `<dir>_postgres-data`).
   Verifică: `docker volume ls | grep -E 'orar-data|postgres-data'`.
3. **Parola Postgres**: volumul existent păstrează `change-me`. Pune o parolă nouă în `.env`, apoi
   schimb-o în baza de date înainte de deploy (`deploy.sh` refuză `change-me`):
   ```bash
   docker compose up -d postgres
   docker compose exec postgres psql -U orar -d orar -c "ALTER USER orar PASSWORD '<parola-din-.env>';"
   ./deploy/deploy.sh
   ```
   (Alternativ, temporar `POSTGRES_PASSWORD=change-me` cu `docker compose up -d`, fără `deploy.sh`.)
4. **Proprietar `/data`**: `deploy.sh` schimbă automat fișierele create de vechiul container root în `node:node`.
5. Configurează Caddy + ufw ca mai sus; porturile vechi dispar după recrearea containerelor.
6. **O singură instanță per token de bot.** Oprește orice altă copie (alt server, laptop) care
   folosește același token — altfel polling-ul primește `409 Conflict` și botul pare mort.

## 11. Depanare

| Simptom | Cauză probabilă | Soluție |
|---|---|---|
| **401** în Mini App | Token greșit în `backend/.env` (alt bot decât cel care deschide aplicația); `initData` expirat (aplicația stă deschisă > `INIT_DATA_MAX_AGE_SECONDS`); pagina deschisă în browser, nu din Telegram | Verifică tokenul și `docker compose up -d api`; închide și redeschide Mini App din Telegram |
| **502** de la Caddy | `web` nu rulează sau `WEB_PORT` ≠ portul din Caddyfile | `docker compose ps`; aliniază portul, `sudo systemctl reload caddy` |
| **502** de la nginx | `api` pornește / e oprit / cade | `docker compose logs api`; nginx re-rezolvă `api` dinamic, revine singur când API e sănătos |
| `api` **unhealthy** / restart continuu | Configurație invalidă: în producție API-ul afișează la pornire `Invalid configuration:` cu lista problemelor și iese; sau permisiuni pe `/data` | `docker compose logs --tail=50 api`; corectează `backend/.env`; rulează `./deploy/deploy.sh` (repară `/data`) |
| `password authentication failed for user "orar"` | Parola din `.env` diferă de cea din volumul existent; `/api/health` arată `"postgres":"error"`, catalogul Profesor dă 503 | `ALTER USER` (secțiunea 3.1 / 10), apoi `docker compose up -d api` |
| Botul nu răspunde | Nici `TELEGRAM_POLLING=true`, nici `WEBHOOK_URL` (avertisment în log); două instanțe cu același token (`polling conflict (409)` în log); webhook nesetat / secret greșit; mesaj trimis într-un grup (botul răspunde doar în privat) | Alege un singur mod; oprește celelalte instanțe; `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` |
| Erori **CORS** | `ALLOWED_ORIGINS` nu conține exact originea frontend-ului (schemă + domeniu). Relevant doar dacă frontend-ul e servit de pe altă origine (`VITE_API_URL` setat) | `ALLOWED_ORIGINS=https://orar.exemplu.md`, `docker compose up -d api` |
| `deploy.sh`: `MINI_APP_URL must start with https://` | URL `http` sau gol | Telegram cere HTTPS pentru Mini App |

După orice modificare în `backend/.env` sau `.env`: `docker compose up -d` (recreează containerele
afectate) sau `./deploy/deploy.sh --no-build`.
