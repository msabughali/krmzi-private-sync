#!/bin/sh
set -eu

DATA_DIR="/app/data"
SEED_DIR="/app/data-seed"
SEED_DATA_MODE="${SEED_DATA_MODE:-missing}"

mkdir -p "$DATA_DIR"

seed_file() {
  name="$1"
  src="${SEED_DIR}/${name}"
  dst="${DATA_DIR}/${name}"
  if [ ! -f "$src" ]; then
    return
  fi
  if [ "$SEED_DATA_MODE" = "force" ]; then
    cp "$src" "$dst"
    echo "force-seeded ${name} into ${DATA_DIR}"
  elif [ ! -s "$dst" ]; then
    cp "$src" "$dst"
    echo "seeded ${name} into ${DATA_DIR}"
  fi
}

seed_file "episodes.json"
seed_file "series.json"
seed_file "state.json"

# Existing volumes may already contain an empty baseline file like:
# {"episodes":[]}
# Treat that as uninitialized and promote the bundled seed snapshot.
if [ -f "${SEED_DIR}/episodes.json" ] && [ -f "${DATA_DIR}/episodes.json" ]; then
  if grep -Eq '"episodes"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "${DATA_DIR}/episodes.json"; then
    cp "${SEED_DIR}/episodes.json" "${DATA_DIR}/episodes.json"
    echo "replaced empty episodes.json with seeded snapshot"
  fi
fi

if [ -f "${SEED_DIR}/series.json" ] && [ -f "${DATA_DIR}/series.json" ]; then
  if grep -Eq '"series"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "${DATA_DIR}/series.json"; then
    cp "${SEED_DIR}/series.json" "${DATA_DIR}/series.json"
    echo "replaced empty series.json with seeded snapshot"
  fi
fi

exec "$@"
