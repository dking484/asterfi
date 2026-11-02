#!/bin/bash
# Nightly AsterFi backup: database + Asterisk/AsterFi config + prompts + voicemail. Keeps 14.
set -euo pipefail
DEST=/var/backups/asterfi
STAMP=$(date +%Y%m%d-%H%M)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"
sudo -u postgres pg_dump --clean --if-exists asterfi > "$WORK/asterfi.sql"
tar -czf "$DEST/asterfi-$STAMP.tar.gz" -C "$WORK" asterfi.sql \
  -C / etc/asterisk etc/asterfi usr/share/asterisk/sounds/asterfi var/spool/asterisk/voicemail var/lib/asterfi var/lib/asterisk/astdb.sqlite3 2>/dev/null
chown root:asterisk "$DEST/asterfi-$STAMP.tar.gz"; chmod 640 "$DEST/asterfi-$STAMP.tar.gz"
chown root:asterisk "$DEST"; chmod 750 "$DEST"
ls -1t "$DEST"/asterfi-*.tar.gz | tail -n +15 | xargs -r rm -f
echo "backup written: $DEST/asterfi-$STAMP.tar.gz"
