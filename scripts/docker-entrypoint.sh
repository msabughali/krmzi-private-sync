#!/bin/sh
set -eu

DATA_DIR="/app/data"
SEED_DIR="/app/data-seed"

mkdir -p "$DATA_DIR"

seed_file() {
  name="$1"
  src="${SEED_DIR}/${name}"
  dst="${DATA_DIR}/${name}"
  if [ -f "$src" ] && [ ! -s "$dst" ]; then
    cp "$src" "$dst"
    echo "seeded ${name} into ${DATA_DIR}"
  fi
}

seed_file "episodes.json"
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

exec "$@"
