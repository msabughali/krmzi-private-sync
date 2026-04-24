# KRMZI Private Episode Sync

Private crawler that discovers episode pages from `https://krmzi.onl`, resolves playable Dailymotion links via browser automation, and securely syncs new episodes to your private target API.

## Project structure

- `src/index.js`: run orchestration (crawl -> dedupe -> sync -> state save)
- `src/webServer.js`: simple frontend + episodes API server
- `src/crawler.js`: Playwright crawler with human-like interaction and retries
- `src/parser.js`: episode and video parsing helpers
- `src/syncClient.js`: authenticated POST client for target server sync
- `src/stateStore.js`: local persistent state to avoid duplicate syncing
- `src/episodesStore.js`: local episodes storage used by the frontend
- `web/`: simple frontend (list + player page)
- `deploy/systemd/`: service + timer units
- `deploy/cron/`: cron entry template
- `Dockerfile`, `docker-compose.yml`: containerized deployment

## 1) Local setup

1. Install dependencies:

```bash
npm install
npx playwright install chromium
```

2. Prepare environment:

```bash
cp .env.example .env
```

3. Edit `.env` and set:

- `TARGET_SYNC_ENDPOINT` (private endpoint on your destination server)
- `TARGET_SYNC_TOKEN` (long random secret token)

4. Run once:

```bash
npm run run:once
```

Single episode test:

```bash
node src/index.js --once --episode-url="https://krmzi.onl/episode/your-episode-slug/"
```

Single episode JSON output (script-friendly):

```bash
node src/index.js --once --print-json --episode-url="https://krmzi.onl/episode/your-episode-slug/"
```

5. Run looping worker (every `INTERVAL_MINUTES`):

```bash
npm run run:loop
```

## Simple frontend

Run:

```bash
npm run web
```

Open:

`http://localhost:8787`

How it works:

- List page calls `/api/episodes` and shows all pulled episodes
- Clicking an episode opens `/play` and embeds the `playerUrl` directly
- Episodes are saved in `EPISODES_FILE_PATH` (default `/app/data/episodes.json` in container)

## 2) Target API contract

The crawler sends:

```json
{
  "source": "krmzi",
  "syncedAt": "2026-04-08T12:00:00.000Z",
  "episodes": [
    {
      "episodeUrl": "https://krmzi.onl/episode/...",
      "slug": "مسلسل-أخي-الحلقة-12",
      "title": "حلقة 12 مسلسل أخي الحلقة 12",
      "episodeNumber": 12,
      "playerUrl": "https://www.dailymotion.com/video/xxxxxxx",
      "playerId": "xxxxxxx",
      "playerProvider": "dailymotion",
      "discoveredAt": "2026-04-08T12:00:00.000Z"
    }
  ]
}
```

The target server should:

- verify `Authorization: Bearer <token>`
- upsert by unique key (`episodeUrl` or `slug + episodeNumber`)
- return `2xx` response for success

## 3) systemd deployment

1. Copy project to server:

```bash
sudo mkdir -p /opt/krmzi-private-sync
sudo rsync -av ./ /opt/krmzi-private-sync/
cd /opt/krmzi-private-sync
npm install --omit=dev
npx playwright install --with-deps chromium
cp .env.example .env
```

2. Install units:

```bash
sudo cp deploy/systemd/krmzi-sync.service /etc/systemd/system/
sudo cp deploy/systemd/krmzi-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krmzi-sync.timer
```

3. Check status:

```bash
systemctl status krmzi-sync.timer
journalctl -u krmzi-sync.service -f
```

## 4) cron deployment

Use file `deploy/cron/krmzi-sync.cron` as template:

```bash
crontab -e
```

Paste:

```cron
*/30 * * * * cd /opt/krmzi-private-sync && /usr/bin/env node src/index.js --once >> /var/log/krmzi-sync.log 2>&1
```

## 5) Docker deployment

The image ships two runtime modes:

- `web` service (default CMD): runs the UI + API on port `8787`
- `worker` service: runs `node src/index.js --loop` for periodic crawls

Both share a named volume (`krmzi-data`) mounted at `/app/data` which holds
`episodes.json` and `state.json`.

1. Build and run:

```bash
cp .env.example .env
docker compose up -d --build
```

2. Open `http://SERVER_IP:8787`.

3. Logs:

```bash
docker compose logs -f web
docker compose logs -f worker
```

4. Stop:

```bash
docker compose down
```

## 6) Coolify deployment

This repo is ready to deploy on [Coolify](https://coolify.io/) as a **Docker Compose** application.

### 6.1 Push to GitHub

```bash
git init
git add .
git commit -m "init: krmzi-private-sync"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

`.env` and the `data/` JSON files are already excluded by `.gitignore`.

### 6.2 Create the Coolify resource

1. In Coolify, **New Resource → Docker Compose → Public Repository** (or Private via GitHub App).
2. Repository: your GitHub URL. Branch: `main`. Base directory: `/`. Compose file: `docker-compose.yml`.
3. Click **Save** and let Coolify parse the compose file. It will detect two services: `web` and `worker`.

### 6.3 Environment variables

Open the **Environment Variables** tab and add at least:

| Key | Example | Notes |
| --- | --- | --- |
| `SOURCE_BASE_URL` | `https://krmzy.com` | Source site root |
| `WEB_PORT` | `8787` | Must match the exposed port |
| `MAX_LIST_PAGES` | `5` | How many listing pages to crawl |
| `MAX_EPISODES_PER_RUN` | `50` | Hard cap per crawl |
| `INTERVAL_MINUTES` | `30` | Worker loop cadence |
| `HEADLESS` | `true` | Keep `true` in containers |
| `LOG_LEVEL` | `info` | |

Optional (only if you also sync to a remote API):

| Key | Example |
| --- | --- |
| `TARGET_SYNC_ENDPOINT` | `https://api.example.com/internal/episodes/sync` |
| `TARGET_SYNC_TOKEN` | `<long-random-token>` (mark as secret) |

Coolify injects these variables into both services automatically — there is no
need for a `.env` file on the server.

### 6.4 Domain & port

- In the **Domains** tab for the `web` service, enter your domain (e.g. `krmzi.example.com`).
- The exposed port is `8787`. Coolify’s built‑in proxy (Traefik) will route
  `:443 → :8787` automatically and issue a Let’s Encrypt certificate.
- The `worker` service has no domain — it runs in the background.

### 6.5 Persistent storage

The compose file declares a named volume `krmzi-data` mounted at `/app/data`.
Coolify creates this volume on the host and reuses it across redeploys, so
`episodes.json` and `state.json` survive rebuilds.

If you prefer a host path, switch the volume in `docker-compose.yml` to:

```yaml
volumes:
  - /var/lib/krmzi/data:/app/data
```

and make sure Coolify’s server user can write to it.

### 6.6 Healthcheck

The web service exposes `GET /api/health` and the Dockerfile declares a
`HEALTHCHECK` against it. Coolify uses this to gate zero‑downtime deploys and
restart the container on failures.

### 6.7 Deploy

Click **Deploy**. First build takes a few minutes (Chromium + its system deps).
Once healthy, open your domain and you should see the episode list. Click
**Refresh** to trigger a crawl, or let the `worker` service populate
`episodes.json` on its own schedule.

## Privacy and reliability recommendations

- Keep `TARGET_SYNC_ENDPOINT` private (VPN, private subnet, or IP allowlist)
- Rotate `TARGET_SYNC_TOKEN` regularly
- Use `DRY_RUN=true` before production
- Keep `data/state.json` persistent to avoid duplicate pushes
- Add alerts on repeated `run_failed` logs
