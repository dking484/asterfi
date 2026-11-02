#!/bin/bash
# One-time server provisioning for AsterFi. Safe to re-run.
# Run as root (install.sh does this). Optional environment:
#   ASTERFI_SOUNDS_DIR  where prompts go: <astdatadir>/sounds/asterfi (default /usr/share/asterisk/sounds/asterfi)
#   ASTERFI_TLS_SAN     subjectAltName for the self-signed certificate (default: hostname + primary IP)
#   SKIP_KOKORO=1       skip the Kokoro text-to-speech voices
set -e
cd "$(dirname "$0")"
SOUNDS=${ASTERFI_SOUNDS_DIR:-/usr/share/asterisk/sounds/asterfi}
mkdir -p /etc/asterfi/tls /opt/asterfi /etc/asterisk/asterfi "$SOUNDS" /var/spool/asterisk/voicemail/asterfi

# Secrets (generated once)
if [ ! -f /etc/asterfi/asterfi.env ]; then
  DBPW=$(openssl rand -hex 16); AMIPW=$(openssl rand -hex 16)
  cat > /etc/asterfi/asterfi.env <<ENV
DATABASE_URL=postgres://asterfi:${DBPW}@127.0.0.1/asterfi
AMI_USER=asterfi
AMI_SECRET=${AMIPW}
ASTERFI_SOUNDS_DIR=${SOUNDS}
ASTERFI_WEB_DIR=/opt/asterfi/web/dist
NODE_ENV=production
ENV
fi
. /etc/asterfi/asterfi.env
DBPW=$(echo "$DATABASE_URL" | sed -E 's#.*asterfi:([^@]+)@.*#\1#')
chown root:asterisk /etc/asterfi/asterfi.env; chmod 640 /etc/asterfi/asterfi.env

# Database
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='asterfi'" </dev/null | grep -q 1 || sudo -u postgres psql -c "CREATE ROLE asterfi LOGIN PASSWORD '${DBPW}'" </dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='asterfi'" </dev/null | grep -q 1 || sudo -u postgres createdb -O asterfi asterfi

# Asterisk base config
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
chown -R asterisk:asterisk /etc/asterisk/asterfi "$SOUNDS" /var/spool/asterisk/voicemail
chmod 640 /etc/asterisk/asterfi/manager_user.conf

# TLS (self-signed until a real cert is installed)
if [ ! -f /etc/asterfi/tls/asterfi.crt ]; then
  IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$(hostname)" \
    -addext "subjectAltName=${ASTERFI_TLS_SAN:-DNS:$(hostname)${IP:+,IP:$IP}}" \
    -keyout /etc/asterfi/tls/asterfi.key -out /etc/asterfi/tls/asterfi.crt 2>/dev/null
fi
cp nginx-asterfi.conf /etc/nginx/sites-available/asterfi
ln -sf /etc/nginx/sites-available/asterfi /etc/nginx/sites-enabled/asterfi
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1 | tail -1
systemctl reload nginx

# Kokoro text-to-speech (CPU, ONNX int8 model)
# Optional (SKIP_KOKORO=1 skips it); without it, typed prompts use the Flite voice.
if [ "${SKIP_KOKORO:-0}" != 1 ]; then
  ( set -e
    if [ ! -x /opt/asterfi/tts/venv/bin/python ]; then
      mkdir -p /opt/asterfi/tts/models
      python3 -m venv /opt/asterfi/tts/venv
      /opt/asterfi/tts/venv/bin/pip install -q --disable-pip-version-check kokoro-onnx soundfile
    fi
    K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
    [ -f /opt/asterfi/tts/models/kokoro-v1.0.int8.onnx ] || curl -fsSL -o /opt/asterfi/tts/models/kokoro-v1.0.int8.onnx $K/kokoro-v1.0.int8.onnx
    [ -f /opt/asterfi/tts/models/voices-v1.0.bin ] || curl -fsSL -o /opt/asterfi/tts/models/voices-v1.0.bin $K/voices-v1.0.bin
    install -m 755 tts/kokoro_tts.py /opt/asterfi/tts/kokoro_tts.py
  ) || { echo "WARNING: Kokoro text-to-speech didn't install; typed prompts will use Flite."; rm -rf /opt/asterfi/tts/venv; }
fi

cp asterfi.service /etc/systemd/system/asterfi.service
mkdir -p /opt/asterfi/bin && install -m 755 backup.sh /opt/asterfi/bin/backup.sh
cp asterfi-backup.service asterfi-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable asterfi >/dev/null 2>&1
systemctl enable --now asterfi-backup.timer >/dev/null 2>&1
systemctl restart asterisk
sleep 3
asterisk -rx 'manager show users' || true
asterisk -rx 'pjsip show transports' | tail -4 || true
echo SETUP_DONE
