#!/bin/sh
set -e

# Named volumes are created root-owned on first use. Make the persisted state
# writable by the unprivileged node user before dropping root privileges.
mkdir -p /data
chown -R node:node /data 2>/dev/null || true

exec gosu node "$@"
