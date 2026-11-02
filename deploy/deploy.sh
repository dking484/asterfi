#!/bin/bash
# Push server (and web/dist if built) to /opt/asterfi and restart. Run from deploy/.
set -e
cd "$(dirname "$0")"
./r.sh 'rm -rf /tmp/asterfi-src && mkdir -p /tmp/asterfi-src/server /tmp/asterfi-src/web'
./up.sh ../server/src /tmp/asterfi-src/server/
./up.sh ../server/package.json /tmp/asterfi-src/server/
[ -f ../server/package-lock.json ] && ./up.sh ../server/package-lock.json /tmp/asterfi-src/server/
[ -d ../web/dist ] && ./up.sh ../web/dist /tmp/asterfi-src/web/
cat > /tmp/asterfi-install.sh <<'S'
set -e
mkdir -p /opt/asterfi/server /opt/asterfi/web /var/lib/asterfi/unifi && chown -R asterisk:asterisk /var/lib/asterfi
rm -rf /opt/asterfi/server/src && cp -r /tmp/asterfi-src/server/src /opt/asterfi/server/
cp /tmp/asterfi-src/server/package*.json /opt/asterfi/server/
if [ -d /tmp/asterfi-src/web/dist ]; then rm -rf /opt/asterfi/web/dist && cp -r /tmp/asterfi-src/web/dist /opt/asterfi/web/; fi
cd /opt/asterfi/server
if ! cmp -s package.json .installed-package.json; then npm install --omit=dev --no-audit --no-fund --loglevel=error && cp package.json .installed-package.json; fi
chown -R root:root /opt/asterfi
systemctl restart asterfi
sleep 4
systemctl is-active asterfi
journalctl -u asterfi -n 25 --no-pager -o cat
S
./r.sh -s /tmp/asterfi-install.sh
