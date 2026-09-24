#!/usr/bin/env bash
set -euo pipefail
: "${MONGO_INITDB_ROOT_USERNAME:?Set MongoDB root username}"
: "${MONGO_INITDB_ROOT_PASSWORD:?Set MongoDB root password}"
: "${MONGO_APP_PASSWORD:?Set application database password}"
: "${MONGO_REPLICA_HOST:?Set the private replica-set hostname}"
umask 077
if [ ! -s /data/db/keyfi.key ]; then
  openssl rand -base64 512 > /data/db/keyfi.key
fi
chown mongodb:mongodb /data/db/keyfi.key
chmod 400 /data/db/keyfi.key
(
  for attempt in $(seq 1 120); do
    if mongosh --quiet --file /opt/keyfi/init.js >/dev/null 2>&1; then exit 0; fi
    sleep 2
  done
  printf 'mongodb_bootstrap_failed\n' >&2
) &
exec /usr/local/bin/docker-entrypoint.sh "$@"
