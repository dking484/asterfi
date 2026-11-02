#!/bin/bash
# One-time server provisioning for AsterFi. Safe to re-run.
set -e
mkdir -p /etc/asterfi/tls /opt/asterfi /etc/asterisk/asterfi /usr/share/asterisk/sounds/asterfi /var/spool/asterisk/voicemail/asterfi

# Secrets (generated once)
if [ ! -f /etc/asterfi/asterfi.env ]; then
  DBPW=$(openssl rand -hex 16); AMIPW=$(openssl rand -hex 16)
  cat > /etc/asterfi/asterfi.env <<ENV
DATABASE_URL=postgres://asterfi:${DBPW}@127.0.0.1/asterfi
AMI_USER=asterfi
AMI_SECRET=${AMIPW}
ASTERFI_SOUNDS_DIR=/usr/share/asterisk/sounds/asterfi
ASTERFI_WEB_DIR=/opt/asterfi/web/dist
NODE_ENV=production
ENV
fi
. /etc/asterfi/asterfi.env
DBPW=$(echo "$DATABASE_URL" | sed -E 's#.*asterfi:([^@]+)@.*#\1#')
chown root:asterisk /etc/asterfi/asterfi.env; chmod 640 /etc/asterfi/asterfi.env

# Database
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='asterfi'" | grep -q 1 || sudo -u postgres psql -c "CREATE ROLE asterfi LOGIN PASSWORD '${DBPW}'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='asterfi'" | grep -q 1 || sudo -u postgres createdb -O asterfi asterfi

# Asterisk base config
cd /tmp/asterfi-deploy
for f in pjsip.conf extensions.conf voicemail.conf manager.conf rtp.conf logger.conf cdr.conf modules.conf http.conf queues.conf; do
  [ -f /etc/asterisk/$f ] && [ ! -f /etc/asterisk/$f.orig ] && cp /etc/asterisk/$f /etc/asterisk/$f.orig
  cp asterisk/$f /etc/asterisk/$f
done
cat > /etc/asterisk/asterfi/manager_user.conf <<AMI
[${AMI_USER}]
secret=${AMI_SECRET}
deny=0.0.0.0/0.0.0.0
permit=127.0.0.1/255.255.255.255
read=all
write=all
writetimeout=5000
AMI
for f in pjsip_transports.conf pjsip_users.conf pjsip_trunks.conf extensions.conf voicemail.conf queues.conf; do
  [ -f /etc/asterisk/asterfi/$f ] || touch /etc/asterisk/asterfi/$f
done
cat > /etc/asterisk/asterfi/pjsip_transports.conf <<T
[asterfi-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

[asterfi-tcp]
type=transport
protocol=tcp
bind=0.0.0.0:5060
T
chown -R asterisk:asterisk /etc/asterisk/asterfi /usr/share/asterisk/sounds/asterfi /var/spool/asterisk/voicemail
chmod 640 /etc/asterisk/asterfi/manager_user.conf

# TLS (self-signed until a real cert is installed)
if [ ! -f /etc/asterfi/tls/asterfi.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=asterfi" \
    -addext "subjectAltName=DNS:asterfi,IP:192.0.2.10" \
    -keyout /etc/asterfi/tls/asterfi.key -out /etc/asterfi/tls/asterfi.crt 2>/dev/null
fi
cp nginx-asterfi.conf /etc/nginx/sites-available/asterfi
ln -sf /etc/nginx/sites-available/asterfi /etc/nginx/sites-enabled/asterfi
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1 | tail -1
systemctl reload nginx

# Kokoro text-to-speech (CPU, ONNX int8 model)
if [ ! -x /opt/asterfi/tts/venv/bin/python ]; then
  apt-get install -y -qq python3-venv >/dev/null
  mkdir -p /opt/asterfi/tts/models
  python3 -m venv /opt/asterfi/tts/venv
  /opt/asterfi/tts/venv/bin/pip install -q --disable-pip-version-check kokoro-onnx soundfile
fi
K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f /opt/asterfi/tts/models/kokoro-v1.0.int8.onnx ] || curl -sSL -o /opt/asterfi/tts/models/kokoro-v1.0.int8.onnx $K/kokoro-v1.0.int8.onnx
[ -f /opt/asterfi/tts/models/voices-v1.0.bin ] || curl -sSL -o /opt/asterfi/tts/models/voices-v1.0.bin $K/voices-v1.0.bin
install -m 755 tts/kokoro_tts.py /opt/asterfi/tts/kokoro_tts.py

cp asterfi.service /etc/systemd/system/asterfi.service
mkdir -p /opt/asterfi/bin && install -m 755 backup.sh /opt/asterfi/bin/backup.sh
cp asterfi-backup.service asterfi-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable asterfi >/dev/null 2>&1
systemctl enable --now asterfi-backup.timer >/dev/null 2>&1
systemctl restart asterisk
sleep 3
asterisk -rx 'manager show users'
asterisk -rx 'pjsip show transports' | tail -4
echo SETUP_DONE
