# Data backups

This directory holds point-in-time snapshots of the runtime data files
(`episodes.json`, `series.json`, `state.json`) and, when relevant, of the
named Docker volume that backs `/app/data`.

It is local-only by default (`backups/*` is gitignored). A specific
snapshot is committed only when it is intended as a recovery point
shipped alongside an ops change (look for `!backups/<timestamp>/` lines
in `.gitignore` to see which ones are tracked).

## Layout

```
backups/
  <YYYYMMDD-HHMMSS>/
    host-data/             # files from ./data on the host at snapshot time
    volume-krmzi-data/     # full contents of the krmzi-data named volume
```

## How to take a new local backup

```bash
TS=$(date +%Y%m%d-%H%M%S)
DIR="backups/$TS"
mkdir -p "$DIR/host-data" "$DIR/volume-krmzi-data"

# 1) host ./data
cp -p data/*.json "$DIR/host-data/" 2>/dev/null || true

# 2) live named volume (only meaningful if you are NOT using the local
#    bind-mount override; with the bind mount, host-data already covers it)
docker run --rm \
  -v qrmazi_krmzi-data:/src:ro \
  -v "$PWD/$DIR/volume-krmzi-data":/dst \
  alpine sh -c 'cp -a /src/. /dst/'
```

## How to restore a snapshot in production (Coolify)

The production `web` and `worker` services share a named volume mounted
at `/app/data`. To restore data from a snapshot tracked in this repo,
run on the production host (after the new code is deployed and the
containers are up):

```bash
SNAPSHOT="backups/20260427-215039"        # adjust to the desired snapshot
SERVICE="web"                             # any service that mounts /app/data

# Sanity check: confirm files exist in the repo checkout
ls "$SNAPSHOT/volume-krmzi-data" || ls "$SNAPSHOT/host-data"

# Stop only the worker so it cannot save over the restore mid-copy.
docker compose stop worker

# Copy the snapshot into the live container's /app/data.
# Prefer volume-krmzi-data if present (full snapshot incl. .seed-version),
# otherwise fall back to host-data.
SRC="$SNAPSHOT/volume-krmzi-data"
[ -d "$SRC" ] || SRC="$SNAPSHOT/host-data"

for f in episodes.json series.json state.json .seed-version; do
  [ -f "$SRC/$f" ] && docker compose cp "$SRC/$f" "$SERVICE:/app/data/$f"
done

# Resume the worker.
docker compose start worker
```

The `.seed-version` marker is intentionally restored last so the
entrypoint on the next restart sees an unchanged signature and does
NOT re-seed `/app/data` from the bundled image snapshot.

## Pruning

`backups/` snapshots are not auto-rotated. Remove old ones manually:

```bash
rm -rf backups/<timestamp>
```

If a tracked snapshot is no longer needed, also remove its allow-list
lines from `.gitignore` and `git rm -r` the directory.
