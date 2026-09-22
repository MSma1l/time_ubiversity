# Orar Univer pe „serverhome” — `https://time-university.sma1lsoft.eu`

Pași pentru serverul „serverhome” (Ubuntu 22.04, Docker 29, **`docker-compose` v1.29.2**, fără buildx, porturile 80/443 deținute de `nginx_proxy`). Pentru un VPS obișnuit vezi [docs/DEPLOY.md](../../docs/DEPLOY.md).

```
Internet ─HTTPS─> nginx_proxy ─shared-network─> time-university-web:80 ─internal─> api:3001 ─> db:5432
                                                                                  └─> data/sqlite
```

## Structura

```
/srv/apps/time-university/
├── compose.yaml   ← copiat de deploy.sh din src/deploy/serverhome/
├── .env           ← secretele (chmod 600); compose îl citește pentru interpolare, API-ul primește
│                    doar variabilele listate explicit în `environment:` din compose.yaml
├── .env.example
├── README.md
├── data/sqlite/   ← orar.sqlite (proprietar uid 1000 = deea)
├── data/postgres/ ← PostgreSQL 16 (proprietar uid 70, creat de container)
├── backups/       ← backup.sh: <AAAA-LL-ZZ_HHMMSS>/{postgres.dump,orar.sqlite.gz,SHA256SUMS}
└── src/           ← codul sursă
```

Containere: `time-university-web` (singurul în `shared-network`), `time-university-api` (serviciul **trebuie** să se numească `api`, nginx-ul din imagine caută `api:3001`), `time-university-db`. Fișiere: `compose.yaml`, `.env.example`, `build.sh`, `deploy.sh`, `backup.sh`, `nginx/*.conf`.

## 1. Primul deploy

```bash
# o singură dată, ca administrator
sudo mkdir -p /srv/apps/time-university && sudo chown -R deea: /srv/apps/time-university
# split DNS: address=/time-university.sma1lsoft.eu/192.168.1.10 în /etc/dnsmasq.d/serverhome-split-dns.conf
sudo systemctl restart dnsmasq

# ca deea
mv ~/time-university-src /srv/apps/time-university/src      # sau: git clone <depozit> src
cd /srv/apps/time-university
./src/deploy/serverhome/build.sh            # time-university-api:prod, time-university-web:prod (câteva minute)
cp src/deploy/serverhome/.env.example .env && chmod 600 .env
openssl rand -hex 24                        # → POSTGRES_PASSWORD
nano .env                                   # POSTGRES_PASSWORD, TELEGRAM_BOT_TOKEN, SEMESTERS
./src/deploy/serverhome/deploy.sh           # sincronizează fișierele, validează .env, up -d, așteaptă healthy
```

Verificare din proxy (fără DNS și certificat):

```bash
docker exec nginx_proxy wget -qO- http://time-university-web/nginx-health     # ok
docker exec nginx_proxy wget -qO- http://time-university-web/api/health       # {"ok":true,...}
```

**Un singur bot activ per token**: oprește orice altă instanță (laptop, alt server) înainte de pornire, altfel polling-ul primește 409.

### Variabilele aplicației

`compose.yaml` **nu** folosește `env_file`: ar împinge tot fișierul în container, inclusiv
`POSTGRES_PASSWORD` și `BACKUP_RETENTION_DAYS`, pe care API-ul nu le citește niciodată și pe care
`docker inspect` le-ar expune. În locul lui, serviciul `api` are o listă explicită sub `environment:`,
cu valorile tot din același `.env`, prin interpolare.

> **Consecință: o variabilă nouă a aplicației trebuie adăugată în DOUĂ locuri** — în `.env` (și în
> `.env.example`) **și** în lista `environment:` a serviciului `api` din `compose.yaml`. Altfel nu ajunge
> niciodată în container și aplicația folosește tăcut valoarea implicită. Verificare:
>
> ```bash
> docker-compose config | sed -n '/^  api:/,/^  db:/p' | grep NUME_VARIABILA
> ```

`SEMESTERS` (calendarul academic: `START:even|odd[:END]`, separate prin virgulă) este propagată deja.
Lăsată goală, se folosește semestrul implicit — vezi `.env.example` și `docs/DEPLOY.md`, secțiunea 3.3.

## 2. Vhost și certificat

DNS **A** `time-university.sma1lsoft.eu` → IP-ul public; routerul trimite TCP 80/443 către `192.168.1.10`.

> ⚠️ **Precondiție obligatorie — zonele `perip` și `peripconn` în `nginx.conf`-ul proxy-ului.**
> Vhost-ul HTTPS (`time-university.sma1lsoft.eu.conf`) folosește `limit_req zone=perip` și
> `limit_conn peripconn`. Zonele **nu** pot fi declarate într-un fișier din `conf.d/` (sunt
> directive de nivel `http{}`). Dacă lipsesc din `nginx.conf`-ul containerului `nginx_proxy`,
> `nginx -t` eșuează cu `unknown limit_req zone "perip"` și **reload-ul întregului proxy e blocat**:
> toate celelalte site-uri de pe serverhome rămân pe configurația veche, iar orice modificare
> ulterioară de vhost nu se aplică. Verifică ÎNAINTE de a copia vhost-ul HTTPS:
>
> ```bash
> docker exec nginx_proxy grep -nE 'limit_(req|conn)_zone' /etc/nginx/nginx.conf
> ```
>
> Dacă nu apare nimic, adaugă în `/srv/proxy/nginx.conf`, în blocul `http { ... }`, înainte de
> `include /etc/nginx/conf.d/*.conf;`:
>
> ```nginx
> # Limite per adresă IP, folosite de vhost-urile din conf.d (Orar Univer: burst=60, 30 conexiuni).
> limit_req_zone  $binary_remote_addr zone=perip:10m rate=30r/s;
> limit_conn_zone $binary_remote_addr zone=peripconn:10m;
> ```
>
> apoi `docker exec nginx_proxy nginx -t && docker exec nginx_proxy nginx -s reload`. Zonele sunt
> partajate de toate site-urile proxy-ului: dacă există deja cu alte nume, schimbă numele în
> `deploy/serverhome/nginx/time-university.sma1lsoft.eu.conf` (liniile `limit_req` / `limit_conn`)
> în loc să le dublezi. Dacă nu ai acces la `nginx.conf`-ul proxy-ului, comentează cele două linii
> din vhost înainte de a-l copia — altfel blochezi reload-ul pentru toată lumea.
> Varianta „Pasul 1 — doar HTTP" (`*.http.conf`) nu folosește zonele, deci nu are precondiții.

**Pasul 1 — doar HTTP:**

```bash
cp /srv/apps/time-university/src/deploy/serverhome/nginx/time-university.sma1lsoft.eu.http.conf /srv/proxy/conf.d/time-university.sma1lsoft.eu.conf
docker exec nginx_proxy nginx -t && docker exec nginx_proxy nginx -s reload
```

**Certificatul** (certbot oficial, webroot):

```bash
docker run --rm -v /srv/proxy/certbot/conf:/etc/letsencrypt -v /srv/proxy/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot -d time-university.sma1lsoft.eu \
  --agree-tos --register-unsafely-without-email --non-interactive
```

**Pasul 2 — HTTPS** (același nume în `conf.d`; verifică întâi zonele `perip`/`peripconn` de mai sus):

```bash
cp /srv/apps/time-university/src/deploy/serverhome/nginx/time-university.sma1lsoft.eu.conf /srv/proxy/conf.d/time-university.sma1lsoft.eu.conf
# nginx -t eșuează dacă zonele lipsesc; până la un `nginx -t` curat, NU da reload.
docker exec nginx_proxy nginx -t && docker exec nginx_proxy nginx -s reload
curl -s https://time-university.sma1lsoft.eu/api/health
```

**Reînnoire**: un singur cron `certbot renew` reînnoiește toate certificatele din `/srv/proxy/certbot/conf`; dacă nu există deja (`crontab -l`), adaugă cu `crontab -e`:

```cron
17 3 * * * docker run --rm -v /srv/proxy/certbot/conf:/etc/letsencrypt -v /srv/proxy/certbot/www:/var/www/certbot certbot/certbot renew --quiet && docker exec nginx_proxy nginx -s reload
```

Vhost-ul **nu** trimite `X-Frame-Options` (Telegram Web deschide Mini App-ul într-un iframe; nginx-ul interior trimite CSP cu `frame-ancestors`). HSTS se adaugă o singură dată în proxy.
**@BotFather**: Menu Button / Configure Mini App → `https://time-university.sma1lsoft.eu`.

## 3. Actualizare

```bash
cd /srv/apps/time-university/src && git pull          # sau încarcă din nou arhiva sursă
./deploy/serverhome/backup.sh                          # recomandat înainte
./deploy/serverhome/build.sh                           # :prod curent devine :prev
./deploy/serverhome/deploy.sh                          # recreează doar ce s-a schimbat
docker image prune -f
```

După o modificare doar în `.env`: `cd /srv/apps/time-university && docker-compose up -d`. Dacă ai
**adăugat o variabilă nouă**, asigură-te întâi că apare și în `environment:` din `compose.yaml`
(vezi secțiunea 1, „Variabilele aplicației"), apoi rulează `deploy.sh`, care resincronizează fișierul.

Imaginile de bază (`node:22-alpine`, `nginx:1.27-alpine`, `postgres:16-alpine`) sunt fixate pe digest
în `backend/Dockerfile`, `frontend/Dockerfile` și `compose.yaml`, deci un `git pull` + rebuild **nu**
aduce singur patch-urile de securitate ale imaginilor de bază. Ridică digest-urile manual, lunar —
procedura completă (cum afli digest-ul nou, cum îl verifici, ce controlezi după deploy) este în
`docs/DEPLOY.md`, secțiunea 9.1. Pe serverhome se rulează `docker-compose` v1.29 fără buildx, deci
digest-ul se obține prin `curl` la registry, varianta din secțiunea 9.1.

## 4. Rollback

```bash
docker tag time-university-api:prev time-university-api:prod
docker tag time-university-web:prev time-university-web:prod
cd /srv/apps/time-university && docker-compose up -d
```

Dacă noua versiune a modificat schema SQLite, restaurează și backup-ul făcut înainte (secțiunea 5). Oprire completă: `docker-compose down` (datele din `data/` rămân). Proxy: pune la loc vhost-ul anterior, `nginx -t`, `nginx -s reload`.

## 5. Backup / restaurare

```bash
/srv/apps/time-university/src/deploy/serverhome/backup.sh     # pg_dump + backup online SQLite, retenție 14 zile
crontab -e
# 15 3 * * * /srv/apps/time-university/src/deploy/serverhome/backup.sh >> /srv/apps/time-university/backups/backup.log 2>&1
```

Verificare: `cd backups/<ts> && sha256sum -c SHA256SUMS`. Copiază periodic `backups/` și `.env` în afara serverului.

**PostgreSQL:**

```bash
docker exec -i time-university-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < /srv/apps/time-university/backups/<ts>/postgres.dump
```

**SQLite:**

```bash
cd /srv/apps/time-university
docker-compose stop api
gunzip -c backups/<ts>/orar.sqlite.gz > data/sqlite/orar.sqlite
rm -f data/sqlite/orar.sqlite-wal data/sqlite/orar.sqlite-shm
docker-compose up -d
```

## 6. Jurnale și depanare

```bash
cd /srv/apps/time-university
docker-compose ps
docker-compose logs -f --tail=100 api time-university-web
docker-compose logs --tail=100 db
```

- `api` repornește continuu → `Invalid configuration:` în log; corectează `.env`, `docker-compose up -d`.
- `password authentication failed` → parola din `.env` diferă de cea cu care s-a inițializat `data/postgres`; `ALTER USER` (vezi `.env.example`).
- 502 de la proxy → `time-university-web` oprit; 502 de la nginx-ul interior → `api` oprit/pornește.
- `nginx -t` în `nginx_proxy` dă `unknown limit_req zone "perip"` → lipsesc `limit_req_zone` /
  `limit_conn_zone` din `nginx.conf`-ul proxy-ului (vezi avertismentul din secțiunea 2).
- Jurnalele Docker sunt limitate la 3 × 10 MB per container.
