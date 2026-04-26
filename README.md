# KRMZI Private Episode Sync

Private crawler that discovers episode pages from `https://krmzi.onl`, resolves
playable Dailymotion links via browser automation, and securely syncs new
episodes to your private target API.

> **Runtime:** this project is only supported via **Docker Compose** (locally or
> through Coolify). All other run methods (systemd, cron, bare `node`) have
> been intentionally removed to keep one source of truth.

## Project structure

- `src/index.js`: run orchestration (crawl → dedupe → sync → state save). Used by the `worker` service.
- `src/webServer.js`: episodes API + frontend server. Used by the `web` service.
- `src/crawler.js`: Playwright crawler with human-like interaction and retries.
- `src/parser.js`: episode and video parsing helpers.
- `src/syncClient.js`: authenticated POST client for target server sync.
- `src/stateStore.js`: local persistent state to avoid duplicate syncing.
- `src/episodesStore.js`: local episodes storage used by the frontend.
- `web/`: simple frontend (list + player page).
- `Dockerfile`, `docker-compose.yml`: containerized deployment (the only supported way).
- `scripts/docker-entrypoint.sh`: seeds `/app/data/*.json` from the bundled snapshot on first boot.

## 1) Target API contract

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

## 2) Run locally with Docker Compose

The compose stack ships two services that share a named volume `krmzi-data`
mounted at `/app/data` (holds `episodes.json`, `series.json`, `state.json`):

- `web`: runs the UI + API on port `8787` (default `CMD`).
- `worker`: runs `node src/index.js --loop` for periodic crawls.

Steps:

```bash
cp .env.example .env
# edit .env and set SOURCE_BASE_URL, optional TARGET_SYNC_*, etc.

docker compose up -d --build
```

Open `http://localhost:8787`.

Logs / lifecycle:

```bash
docker compose logs -f web
docker compose logs -f worker
docker compose down
```

That is the only supported local workflow. Do not run `node src/...` outside
the container — the data paths, Playwright browser, and entrypoint seeding all
assume the Docker environment.

## 3) Coolify deployment

This repo is built to deploy on [Coolify](https://coolify.io/) as a
**Docker Compose** application.

### 3.1 Push to GitHub

```bash
git init
git add .
git commit -m "init: krmzi-private-sync"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

`.env` and the `data/*.json` runtime files are excluded by `.gitignore`.

### 3.2 Create the Coolify resource

1. **New Resource → Docker Compose → Public Repository** (or Private via the
   GitHub App).
2. Repository: your GitHub URL. Branch: `main`. Base directory: `/`.
   Compose file: `docker-compose.yml`.
3. Click **Save** and let Coolify parse the compose file. It will detect two
   services: `web` and `worker`.

### 3.3 Why this compose file is Coolify-safe

The compose intentionally avoids three things that commonly break Coolify
redeploys:

- **No `container_name`** — Coolify generates unique container names per
  deploy. Hard-coded names cause `Conflict. The container name is already in use`
  on the second deploy.
- **No host `ports:` mapping** — only `expose: ["8787"]` is declared. Coolify’s
  built-in Traefik proxy routes the service domain directly to the exposed
  port, which avoids host-port collisions when the same server runs other apps.
- **No fixed `image:` tag** — Coolify tags built images per resource so two
  Coolify projects can build the same compose file without overwriting each
  other’s image.

### 3.4 Environment variables

Open the **Environment Variables** tab on the resource and add at least:

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
need for a `.env` file on the server. The compose file’s `env_file: .env`
entry is declared with `required: false` so it is silently skipped when the
file is absent.

### 3.5 Domain & port

- In the **Domains** tab for the `web` service, enter your domain
  (e.g. `krmzi.example.com`).
- The exposed port is `8787`. Coolify’s proxy will route `:443 → :8787`
  automatically and issue a Let’s Encrypt certificate.
- The `worker` service has no domain — it runs in the background.

### 3.6 Persistent storage

The compose file declares a named volume `krmzi-data` mounted at `/app/data`.
Coolify creates this volume on the host and reuses it across redeploys, so
`episodes.json`, `series.json`, and `state.json` survive rebuilds.

If you prefer a host path, switch the volume in `docker-compose.yml` to:

```yaml
volumes:
  - /var/lib/krmzi/data:/app/data
```

and make sure Coolify’s server user can write to it.

### 3.7 Healthcheck

The web service exposes `GET /api/health` and the compose file declares a
`HEALTHCHECK` against it. Coolify uses this to gate zero-downtime deploys and
restart the container on failures.

### 3.8 Deploy

Click **Deploy**. The first build takes a few minutes (Chromium + its system
deps). Once healthy, open your domain and you should see the episode list.
The `worker` service populates `episodes.json` on its own schedule.

## 4) Privacy and reliability recommendations

- Keep `TARGET_SYNC_ENDPOINT` private (VPN, private subnet, or IP allowlist).
- Rotate `TARGET_SYNC_TOKEN` regularly.
- Use `DRY_RUN=true` before production.
- Keep the `krmzi-data` volume persistent to avoid duplicate pushes.
- Add alerts on repeated `run_failed` logs.
