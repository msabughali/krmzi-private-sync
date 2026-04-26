#!/bin/sh
set -eu

DATA_DIR="/app/data"
SEED_DIR="/app/data-seed"
SEED_DATA_MODE="${SEED_DATA_MODE:-auto}"
MARKER_FILE="${DATA_DIR}/.seed-version"

mkdir -p "$DATA_DIR"

# Compute a stable signature for the bundled seed snapshot. Any change to
# the seed files (size or content) flips this hash, which lets us detect a
# new image build without requiring the user to bump a version manually.
compute_seed_signature() {
  if [ ! -d "$SEED_DIR" ]; then
    echo "no-seed"
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$SEED_DIR" && \
      find . -maxdepth 2 -type f \( -name '*.json' -o -name '.gitkeep' \) \
        -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null) \
      | sha256sum | awk '{print $1}'
  else
    # BusyBox fallback: hash by concatenating files.
    (cd "$SEED_DIR" && \
      find . -maxdepth 2 -type f \( -name '*.json' -o -name '.gitkeep' \) \
        -print0 2>/dev/null | sort -z | xargs -0 cat 2>/dev/null) \
      | md5sum | awk '{print $1}'
  fi
}

SEED_SIGNATURE="$(compute_seed_signature || echo "unknown")"
PREVIOUS_SIGNATURE=""
if [ -f "$MARKER_FILE" ]; then
  PREVIOUS_SIGNATURE="$(cat "$MARKER_FILE" 2>/dev/null || true)"
fi

# Decide whether this boot should overwrite the volume's data files.
# - SEED_DATA_MODE=force      → always overwrite
# - SEED_DATA_MODE=missing    → only fill files that are missing/empty
# - SEED_DATA_MODE=auto (def) → overwrite when the bundled seed changed
#                                (image rebuild), otherwise behave like
#                                "missing" so user-accumulated data is
#                                preserved across container restarts
case "$SEED_DATA_MODE" in
  force)
    SHOULD_OVERWRITE=1
    REASON="force"
    ;;
  missing)
    SHOULD_OVERWRITE=0
    REASON="missing"
    ;;
  auto|*)
    if [ -z "$PREVIOUS_SIGNATURE" ] || [ "$PREVIOUS_SIGNATURE" != "$SEED_SIGNATURE" ]; then
      SHOULD_OVERWRITE=1
      REASON="auto-bundled-seed-changed"
    else
      SHOULD_OVERWRITE=0
      REASON="auto-bundled-seed-unchanged"
    fi
    ;;
esac

echo "seed: mode=${SEED_DATA_MODE} reason=${REASON} signature=${SEED_SIGNATURE} previous=${PREVIOUS_SIGNATURE:-<none>}"

seed_file() {
  name="$1"
  src="${SEED_DIR}/${name}"
  dst="${DATA_DIR}/${name}"
  if [ ! -f "$src" ]; then
    return
  fi
  if [ "$SHOULD_OVERWRITE" = "1" ]; then
    cp "$src" "$dst"
    echo "overwrote ${name} from bundled seed (${REASON})"
  elif [ ! -s "$dst" ]; then
    cp "$src" "$dst"
    echo "seeded missing ${name} from bundled seed"
  fi
}

seed_file "episodes.json"
seed_file "series.json"
seed_file "state.json"

# Existing volumes may still contain a degraded baseline file like
# {"episodes":[]} from older deployments. Treat those as uninitialized
# regardless of the marker so the bundled snapshot wins.
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

# Persist the signature so subsequent restarts of this container don't
# re-seed unnecessarily; only a new image (with a different bundled
# snapshot) triggers another overwrite.
printf '%s\n' "$SEED_SIGNATURE" > "$MARKER_FILE"

exec "$@"
