#!/bin/bash
# AsterFi installer for a fresh Debian (12+) or Ubuntu (22.04+) server. Run as root from the repository:
#
#   sudo ./install.sh
#
# Installs and configures everything AsterFi needs: Asterisk 22 (the distribution's package when it is
# version 22 or newer, otherwise built from source), PostgreSQL, Node.js 22, nginx with a self-signed
# certificate, ffmpeg/sox/lame/flite for audio, Kokoro text-to-speech, faster-whisper voicemail transcription,
# the AsterFi service and the nightly backup timer. Safe to re-run: a second run updates AsterFi to this
# checkout and keeps the database, settings, prompts and voicemail.
#
# Options (environment variables):
#   ASTERISK_FROM_SOURCE=1   build Asterisk 22 from source even when the distribution has a package
#   SKIP_KOKORO=1            skip the Kokoro voices (~350 MB); prompts fall back to the Flite voice
#   SKIP_STT=1               skip voicemail transcription (faster-whisper, ~650 MB)
#   ASTERFI_TLS_NAMES=...    extra names/IPs for the certificate, comma-separated (e.g. pbx.example.com)
set -euo pipefail

REPO=$(cd "$(dirname "$0")" && pwd)
LOG=/var/log/asterfi-install.log
ASTERISK_MAJOR=22
NODE_MAJOR=22

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "Install failed on line $LINENO. Details: $LOG"' ERR
export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -q --no-install-recommends "$@" >>"$LOG" 2>&1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo ./install.sh"
[ -f /etc/os-release ] || die "Can't tell which Linux this is (no /etc/os-release)."
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*) ;;
  *) die "This installer supports Debian and Ubuntu only (found ${PRETTY_NAME:-unknown})." ;;
esac
[ -f "$REPO/server/package.json" ] && [ -f "$REPO/web/package.json" ] || die "Run install.sh from the AsterFi repository."
: >"$LOG"
echo "AsterFi installer on ${PRETTY_NAME}. Log: $LOG"

# --- base packages ---------------------------------------------------------------------------------
step "Installing system packages"
apt-get update -q >>"$LOG" 2>&1
apt_install ca-certificates curl wget gnupg openssl sudo git rsync procps iproute2 \
  postgresql nginx ffmpeg sox lame flite python3 python3-venv python3-pip
note "PostgreSQL, nginx, ffmpeg, sox, lame, flite, Python"

# --- Asterisk --------------------------------------------------------------------------------------
step "Installing Asterisk $ASTERISK_MAJOR"
pkg_major=$(apt-cache policy asterisk 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -E 's/^[0-9]+://; s/[^0-9].*//')
have_major=$(command -v asterisk >/dev/null && asterisk -V | sed -E 's/^Asterisk ([0-9]+).*/\1/' || echo 0)

if [ "${have_major:-0}" -ge "$ASTERISK_MAJOR" ] 2>/dev/null; then
  note "Asterisk $(asterisk -V | awk '{print $2}') is already installed"
  if dpkg -s asterisk >/dev/null 2>&1; then
    apt_install asterisk asterisk-modules asterisk-core-sounds-en asterisk-core-sounds-en-wav \
      asterisk-core-sounds-en-gsm asterisk-moh-opsound-wav asterisk-moh-opsound-gsm || true
  fi
elif [ "${ASTERISK_FROM_SOURCE:-0}" != 1 ] && [ "${pkg_major:-0}" -ge "$ASTERISK_MAJOR" ] 2>/dev/null; then
  note "Using the ${ID} package (Asterisk $pkg_major)"
  apt_install asterisk asterisk-modules asterisk-core-sounds-en asterisk-core-sounds-en-wav \
    asterisk-core-sounds-en-gsm asterisk-moh-opsound-wav asterisk-moh-opsound-gsm
else
  note "No Asterisk $ASTERISK_MAJOR package here (candidate: ${pkg_major:-none}); building from source."
  note "This takes 10-30 minutes depending on the CPU."
  apt_install build-essential pkg-config autoconf automake libtool bzip2 patch xmlstarlet \
    libedit-dev uuid-dev libjansson-dev libxml2-dev libsqlite3-dev libssl-dev libsrtp2-dev \
    libcurl4-openssl-dev libspeex-dev libspeexdsp-dev libogg-dev libvorbis-dev libopus-dev \
    libncurses-dev libnewt-dev libpopt-dev libical-dev libunbound-dev libgsm1-dev zlib1g-dev
  id asterisk >/dev/null 2>&1 || useradd --system --home-dir /var/lib/asterisk --shell /usr/sbin/nologin --user-group asterisk
  SRC=/usr/src/asterisk-build
  rm -rf "$SRC" && mkdir -p "$SRC"
  curl -fsSL -o "$SRC/asterisk.tar.gz" "https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_MAJOR}-current.tar.gz"
  tar -xzf "$SRC/asterisk.tar.gz" -C "$SRC"
  cd "$SRC"/asterisk-"$ASTERISK_MAJOR".*/
  note "Configuring"
  ./configure --with-pjproject-bundled --with-jansson-bundled >>"$LOG" 2>&1
  make menuselect.makeopts >>"$LOG" 2>&1
  menuselect/menuselect --disable BUILD_NATIVE \
    --enable CORE-SOUNDS-EN-WAV --enable CORE-SOUNDS-EN-GSM \
    --enable MOH-OPSOUND-WAV --enable MOH-OPSOUND-GSM menuselect.makeopts >>"$LOG" 2>&1
  note "Compiling"
  make -j"$(nproc)" >>"$LOG" 2>&1
  note "Installing"
  make install >>"$LOG" 2>&1
  [ -f /etc/asterisk/asterisk.conf ] || make samples >>"$LOG" 2>&1
  make install-logrotate >>"$LOG" 2>&1 || true
  ldconfig
  cd "$REPO"
  # Run as the asterisk user, like the distribution packages do.
  sed -i -E 's/^;?\s*runuser\s*=.*/runuser = asterisk/; s/^;?\s*rungroup\s*=.*/rungroup = asterisk/' /etc/asterisk/asterisk.conf
  cat >/etc/systemd/system/asterisk.service <<'UNIT'
[Unit]
Description=Asterisk PBX
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=asterisk
Group=asterisk
RuntimeDirectory=asterisk
ExecStart=/usr/sbin/asterisk -f -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx 'core reload'
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
  chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk 2>/dev/null || true
  systemctl daemon-reload
  rm -rf "$SRC"
fi
command -v asterisk >/dev/null || die "Asterisk didn't install."
systemctl enable asterisk >>"$LOG" 2>&1 || true
[ "${have_major:-0}" -ge "$ASTERISK_MAJOR" ] 2>/dev/null || note "Installed $(asterisk -V)"

# Where this Asterisk keeps its sounds (Debian/Ubuntu packages: /usr/share/asterisk; source: /var/lib/asterisk).
DATADIR=$(sed -nE 's/^\s*astdatadir\s*=>?\s*([^ ;]+).*/\1/p' /etc/asterisk/asterisk.conf | head -1)
DATADIR=${DATADIR:-/var/lib/asterisk}
export ASTERFI_SOUNDS_DIR="$DATADIR/sounds/asterfi"

# --- Node.js ---------------------------------------------------------------------------------------
step "Installing Node.js $NODE_MAJOR"
node_major=$(command -v node >/dev/null && node -v | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
dist_node=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | sed -E 's/^[0-9]+://; s/[^0-9].*//')
if [ "$node_major" -ge 20 ] 2>/dev/null; then
  note "Node.js $(node -v) is already installed"
elif [ "${dist_node:-0}" -ge 20 ] 2>/dev/null; then
  apt_install nodejs npm
else
  # The distribution's Node.js is too old for Fastify 5: use NodeSource's repository.
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q >>"$LOG" 2>&1
  apt_install nodejs
fi
command -v npm >/dev/null || apt_install npm
note "Node.js $(node -v), npm $(npm -v)"

# --- AsterFi application ---------------------------------------------------------------------------
step "Building the web interface"
BUILD=$(mktemp -d)
rsync -a --exclude node_modules --exclude dist "$REPO/web/" "$BUILD/web/"
(cd "$BUILD/web" && npm ci --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 && npm run build >>"$LOG" 2>&1)
note "Built"

step "Installing AsterFi to /opt/asterfi"
mkdir -p /opt/asterfi/server /opt/asterfi/web /var/lib/asterfi/unifi
rm -rf /opt/asterfi/server/src /opt/asterfi/web/dist
cp -r "$REPO/server/src" /opt/asterfi/server/
cp "$REPO"/server/package*.json /opt/asterfi/server/
cp -r "$BUILD/web/dist" /opt/asterfi/web/
rm -rf "$BUILD"
(cd /opt/asterfi/server && { [ -f package-lock.json ] && npm ci --omit=dev --no-audit --no-fund --loglevel=error || npm install --omit=dev --no-audit --no-fund --loglevel=error; } >>"$LOG" 2>&1)
cp /opt/asterfi/server/package.json /opt/asterfi/server/.installed-package.json
chown -R root:root /opt/asterfi
chown -R asterisk:asterisk /var/lib/asterfi
note "Server dependencies installed"

# --- configuration, database, nginx, TTS, services ---------------------------------------------------
step "Configuring Asterisk, PostgreSQL, nginx, text-to-speech and services"
systemctl enable --now postgresql >>"$LOG" 2>&1
systemctl start asterisk >>"$LOG" 2>&1 || true
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')
# Names the self-signed certificate covers: this host, its address, and any ASTERFI_TLS_NAMES.
SAN="DNS:$(hostname),DNS:localhost${IP:+,IP:$IP}"
IFS=, read -ra extra <<<"${ASTERFI_TLS_NAMES:-}"
for n in "${extra[@]}"; do
  n=${n// /}; [ -n "$n" ] || continue
  if [[ $n =~ ^[0-9.]+$ || $n == *:* ]]; then SAN="$SAN,IP:$n"; else SAN="$SAN,DNS:$n"; fi
done
export ASTERFI_TLS_SAN="$SAN"
bash "$REPO/deploy/setup.sh" >>"$LOG" 2>&1 || die "Configuration failed. Details: $LOG"
note "Done"

# --- firewall ----------------------------------------------------------------------------------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Opening firewall ports (ufw)"
  for p in 80/tcp 443/tcp 5060/udp 5060/tcp 10000:20000/udp 8080/tcp 10001/udp; do ufw allow "$p" >>"$LOG" 2>&1; done
  note "80, 443 (web), 5060 (SIP), 10000-20000/udp (audio), 8080 + 10001/udp (UniFi phones)"
fi

# --- start --------------------------------------------------------------------------------------------
step "Starting AsterFi"
systemctl restart asterfi
# Wait for the web service to answer (any HTTP status means it's up).
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/me)" != 000 ] && break; sleep 1; done
systemctl is-active --quiet asterfi || die "The AsterFi service didn't start. See: journalctl -u asterfi -n 50"
systemctl is-active --quiet asterisk || die "Asterisk isn't running. See: journalctl -u asterisk -n 50"

trap - ERR
cat <<DONE

$(printf '\033[1;32m')AsterFi is installed.$(printf '\033[0m')

  Open  https://${IP:-$(hostname)}/  and create the first administrator.
  (The certificate is self-signed: accept the browser warning, or install a real one at
   /etc/asterfi/tls/asterfi.crt and .key and run: systemctl reload nginx)

  Then, in the web interface:
    Settings > General   web address, public IP (if behind NAT) and time zone
    Settings > Email     SMTP server for voicemail and missed-call emails
    Trunks & Routes      your SIP provider

  Services: asterfi, asterisk, postgresql, nginx, asterfi-backup.timer (nightly, /var/backups/asterfi)
  To update later: git pull, then run sudo ./install.sh again.
DONE
