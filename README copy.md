# Orar Univer · Telegram Bot + Mini App

Mini App mobilă pentru organizarea orelor universitare, cu roluri **Student** și **Profesor**, orar pe săptămâni pare/impare și memento-uri trimise de bot înainte de oră.

## Rulează local

```sh
cp backend/.env.example backend/.env
# pentru UI local, setează ALLOW_DEV_AUTH=true în backend/.env
npm install --prefix backend
npm install --prefix frontend
npm run dev --prefix backend
npm run dev --prefix frontend
```

Deschide `http://localhost:5173`. Pentru test local fără Telegram, API-ul permite `X-Dev-Telegram-Id` numai dacă `ALLOW_DEV_AUTH=true`; Mini App-ul păstrează un exemplu vizual până când este deschisă în Telegram.

## Lansare cu Docker

1. Creează `backend/.env` din exemplu și completează `TELEGRAM_BOT_TOKEN`, `MINI_APP_URL` și `ALLOWED_ORIGINS` cu domeniul HTTPS final.
2. Rulează `docker compose up --build -d`. Interfața devine disponibilă la `http://localhost:8083`, API-ul la `http://localhost:3001`, iar PostgreSQL la `localhost:55434`.
3. Configurează domeniul HTTPS sau tunelul să trimită traficul către portul `8083`. Acesta trebuie să fie exact URL-ul pus în `MINI_APP_URL` și `ALLOWED_ORIGINS`.
4. În @BotFather setează Menu Button / Web App URL la domeniul HTTPS. Pentru comenzi, modul `TELEGRAM_POLLING=true` este deja pregătit; nu porni o a doua instanță cu același token.

Nu adăuga tokenul botului în frontend sau în Git. Telegram verifică server-side semnătura `initData` la fiecare operație de API.

## Orar par/impar

Referința inițială cerută este **7–13 septembrie 2026 = săptămână pară**. Poți comuta manual în Mini App; fiecare activitate este salvată ca `pară`, `impară` sau `în fiecare săptămână`. PDF-ul UTM este o foaie vizuală cu celule unite, deci prima versiune folosește introducere/editare manuală sigură, în locul unei extrageri fragile.
