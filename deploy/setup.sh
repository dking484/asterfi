#!/bin/bash
# One-time server provisioning for AsterFi. Safe to re-run.
# Run as root (install.sh does this). Optional environment:
#   ASTERFI_SOUNDS_DIR  where prompts go: <astdatadir>/sounds/asterfi (default /usr/share/asterisk/sounds/asterfi)
#   ASTERFI_TLS_SAN     subjectAltName for the self-signed certificate (default: hostname + primary IP)
#   SKIP_KOKORO=1       skip the Kokoro text-to-speech voices
#   SKIP_STT=1          skip voicemail transcription (faster-whisper)
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

# Speech add-ons: Kokoro text-to-speech and faster-whisper voicemail transcription. Every Python package is
# pinned in tts/ and stt/requirements.txt and every model by checksum or revision in compatibility.json, so each
# install of an AsterFi release gets exactly what it was tested with. The pins need Python 3.12-3.14; on an older
# Python both are skipped (typed prompts use Flite and voicemails aren't transcribed).
COMPAT=../server/src/compatibility.json
compat() { python3 -c 'import json, sys; v = json.load(open(sys.argv[1]))
for k in sys.argv[2:]: v = v[k]
print(v)' "$COMPAT" "$@"; }
PY_MIN=$(compat components python min); PY_MAX=$(compat components python max)
PY_OK=$(python3 -c "import sys; v = sys.version_info[:2]; lo = tuple(map(int, '$PY_MIN'.split('.'))); hi = tuple(map(int, '$PY_MAX'.split('.'))); print(int(lo <= v <= hi))")
if [ "$PY_OK" != 1 ] && { [ "${SKIP_KOKORO:-0}" != 1 ] || [ "${SKIP_STT:-0}" != 1 ]; }; then
  echo "WARNING: Python $(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])') is outside $PY_MIN-$PY_MAX, which the speech add-ons are tested with."
  echo "         Skipping Kokoro voices (typed prompts use Flite) and voicemail transcription."
  SKIP_KOKORO=1; SKIP_STT=1
fi
# Creates the venv if needed and installs the pinned packages (a no-op when they already match).
pip_pinned() { [ -x "/opt/asterfi/$1/venv/bin/python" ] || python3 -m venv "/opt/asterfi/$1/venv"
  "/opt/asterfi/$1/venv/bin/pip" install -q --disable-pip-version-check -r "$1/requirements.txt"
  install -m 644 "$1/requirements.txt" "/opt/asterfi/$1/requirements.txt"; }

# Kokoro text-to-speech (CPU, ONNX int8 model). SKIP_KOKORO=1 skips it. A failed update keeps the working
# install; only a venv created by this run is removed.
if [ "${SKIP_KOKORO:-0}" != 1 ]; then
  [ -x /opt/asterfi/tts/venv/bin/python ] && TTS_HAD=1 || TTS_HAD=0
  ( set -e
    mkdir -p /opt/asterfi/tts/models
    pip_pinned tts
    K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
    for f in kokoro-v1.0.int8.onnx voices-v1.0.bin; do
      [ -f "/opt/asterfi/tts/models/$f" ] || curl -fsSL -o "/opt/asterfi/tts/models/$f" "$K/$f"
      echo "$(compat kokoroModels "$f")  /opt/asterfi/tts/models/$f" | sha256sum -c --quiet - || { rm -f "/opt/asterfi/tts/models/$f"; exit 1; }
    done
    install -m 755 tts/kokoro_tts.py /opt/asterfi/tts/kokoro_tts.py
  ) || { echo "WARNING: Kokoro text-to-speech didn't install; typed prompts will use Flite."; [ "$TTS_HAD" = 1 ] || rm -rf /opt/asterfi/tts/venv; }
fi

# Voicemail transcription (faster-whisper on the CPU). SKIP_STT=1 skips it.
# Downloads both models Settings offers, at the revisions in compatibility.json: base.en (~150 MB, fast) and
# small.en (~480 MB, more accurate).
if [ "${SKIP_STT:-0}" != 1 ]; then
  [ -x /opt/asterfi/stt/venv/bin/python ] && STT_HAD=1 || STT_HAD=0
  ( set -e
    mkdir -p /opt/asterfi/stt/models
    pip_pinned stt
    install -m 755 stt/whisper_stt.py /opt/asterfi/stt/whisper_stt.py
    for m in base.en small.en; do /opt/asterfi/stt/whisper_stt.py --download $m --revision "$(compat whisperModels $m)"; done
    chmod -R a+rX /opt/asterfi/stt  # some cache files are written 0600; the service runs as asterisk
  ) || { echo "WARNING: voicemail transcription didn't install; voicemails won't be transcribed."; [ "$STT_HAD" = 1 ] || rm -rf /opt/asterfi/stt/venv; }
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
