#!/usr/bin/env bash
# تثبيت نظام مارا على خادم Oracle Cloud
# يعمل على Ubuntu 22.04/24.04 و Oracle Linux 8/9 (معالج Intel/AMD أو Ampere ARM)
#
# الاستخدام (على الخادم):
#   curl -fsSL https://raw.githubusercontent.com/moom11/mara-pos/refs/heads/<الفرع>/deploy/oracle/install.sh | sudo bash
# خيارات:
#   --domain example.com   اسم نطاق خاص (اختياري). بدونه يُستخدم <IP>.sslip.io
#   --branch main          الفرع الذي يُثبَّت منه البرنامج
# إعادة تشغيل السكربت آمنة: يحدّث البرنامج ولا يمس البيانات.
set -euo pipefail

REPO_URL="${MARA_REPO:-https://github.com/moom11/mara-pos.git}"
BRANCH="claude/nice-mccarthy-vv8okk"
DOMAIN=""
APP_DIR="/opt/mara-pos"
DATA_DIR="/var/lib/mara"
APP_PORT=3000

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "خيار غير معروف: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1;31m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mخطأ:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "شغّل السكربت بصلاحية المدير: sudo bash install.sh"

# ---------- 1) الحزم الأساسية ----------
say "تثبيت الحزم الأساسية"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git curl ca-certificates xz-utils tar sqlite3 python3 make g++
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y git curl ca-certificates xz tar sqlite python3 make gcc-c++
else
  die "نظام التشغيل غير مدعوم. استخدم Ubuntu أو Oracle Linux"
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; CADDY_ARCH=amd64 ;;
  aarch64) NODE_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) die "معالج غير مدعوم: $(uname -m)" ;;
esac

# ---------- 2) ذاكرة إضافية للخوادم الصغيرة ----------
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && ! swapon --show | grep -q .; then
  say "إضافة ذاكرة Swap بحجم 2GB (ذاكرة الخادم ${MEM_MB}MB)"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- 3) Node.js 22 (من الموقع الرسمي مع التحقق من البصمة) ----------
say "تثبيت Node.js 22"
SUMS=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)
NODE_LINE=$(printf '%s\n' "$SUMS" | grep -E " node-v22\.[0-9.]+-linux-${NODE_ARCH}\.tar\.xz$" | head -n1)
[ -n "$NODE_LINE" ] || die "تعذر العثور على نسخة Node.js المناسبة"
NODE_FILE=$(printf '%s' "$NODE_LINE" | awk '{print $2}')
NODE_VER=$(printf '%s' "$NODE_FILE" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$NODE_VER" ]; then
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_FILE}" -o "$TMP/$NODE_FILE"
  (cd "$TMP" && printf '%s\n' "$NODE_LINE" | sha256sum -c -) || die "فشل التحقق من ملف Node.js"
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf "$TMP/$NODE_FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  if command -v restorecon >/dev/null 2>&1; then restorecon -R /opt/node || true; fi
  rm -rf "$TMP"
fi
echo "Node.js $(/usr/local/bin/node -v)"

# ---------- 4) مستخدم النظام والمجلدات ----------
say "تجهيز المستخدم والمجلدات"
id mara >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin mara
mkdir -p "$APP_DIR" "$DATA_DIR"
chown mara:mara "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------- 5) تنزيل البرنامج ----------
say "تنزيل البرنامج (الفرع: $BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u mara -H git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo -u mara -H git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  # مجلد الكود فقط (البيانات في مجلد منفصل)، فحذفه آمن إذا كانت محاولة سابقة لم تكتمل
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  chown mara:mara "$APP_DIR"
  sudo -u mara -H git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
say "تثبيت مكتبات البرنامج"
sudo -u mara -H env PATH="/opt/node/bin:$PATH" npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund

# ---------- 6) خدمة البرنامج ----------
say "تشغيل البرنامج كخدمة دائمة"
cat > /etc/systemd/system/mara.service <<EOF
[Unit]
Description=Mara POS
After=network-online.target
Wants=network-online.target

[Service]
User=mara
Group=mara
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
Environment=HOST=127.0.0.1
Environment=DB_FILE=$DATA_DIR/mara.db
Environment=TZ=Asia/Riyadh
ExecStart=/usr/local/bin/node $APP_DIR/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mara >/dev/null
systemctl restart mara

# ---------- 7) العنوان ----------
if [ -z "$DOMAIN" ]; then
  PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || curl -4 -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
  [ -n "$PUBLIC_IP" ] || die "تعذر معرفة العنوان العام للخادم. أعد التشغيل مع --domain"
  DOMAIN="$(printf '%s' "$PUBLIC_IP" | tr '.' '-').sslip.io"
fi

# ---------- 8) Caddy لشهادة HTTPS المجانية ----------
if [ "${SKIP_CADDY:-0}" != "1" ]; then
  say "تثبيت Caddy (شهادة HTTPS تلقائية)"
  if ! command -v caddy >/dev/null 2>&1; then
    CADDY_TAG=$(curl -fsSI https://github.com/caddyserver/caddy/releases/latest | tr -d '\r' | awk -F'/' 'tolower($1) ~ /^location:/ {print $NF}')
    [ -n "$CADDY_TAG" ] || die "تعذر معرفة آخر نسخة من Caddy"
    CADDY_VER="${CADDY_TAG#v}"
    TMP=$(mktemp -d)
    BASE="https://github.com/caddyserver/caddy/releases/download/${CADDY_TAG}"
    curl -fsSL "$BASE/caddy_${CADDY_VER}_linux_${CADDY_ARCH}.tar.gz" -o "$TMP/caddy.tar.gz"
    curl -fsSL "$BASE/caddy_${CADDY_VER}_checksums.txt" -o "$TMP/sums.txt"
    EXPECTED=$(grep " caddy_${CADDY_VER}_linux_${CADDY_ARCH}.tar.gz$" "$TMP/sums.txt" | awk '{print $1}')
    ACTUAL=$(sha512sum "$TMP/caddy.tar.gz" | awk '{print $1}')
    [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || die "فشل التحقق من ملف Caddy"
    tar -xzf "$TMP/caddy.tar.gz" -C "$TMP" caddy
    install -m 0755 "$TMP/caddy" /usr/local/bin/caddy
    if command -v restorecon >/dev/null 2>&1; then restorecon /usr/local/bin/caddy || true; fi
    rm -rf "$TMP"
  fi
  id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  mkdir -p /etc/caddy
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF
  cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable caddy >/dev/null
  systemctl restart caddy
fi

# ---------- 9) جدار الحماية داخل الخادم ----------
say "فتح المنفذين 80 و 443 في جدار حماية الخادم"
if systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
elif command -v iptables >/dev/null 2>&1; then
  # صور Ubuntu في Oracle Cloud ترفض كل المنافذ عدا SSH افتراضياً
  for PORT in 80 443; do
    if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT 2>/dev/null; then
      POS=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
      if [ -n "$POS" ]; then
        iptables -I INPUT "$POS" -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
      else
        iptables -A INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
      fi
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
fi

# ---------- 10) أمر التحديث ----------
cat > /usr/local/bin/mara-update <<EOF
#!/usr/bin/env bash
# تحديث برنامج مارا إلى آخر نسخة (البيانات لا تتأثر)
set -euo pipefail
sudo -u mara -H git -C $APP_DIR fetch --depth 1 origin "\${1:-$BRANCH}"
sudo -u mara -H git -C $APP_DIR reset --hard FETCH_HEAD
sudo -u mara -H env PATH="/opt/node/bin:\$PATH" npm --prefix $APP_DIR ci --omit=dev --no-audit --no-fund
systemctl restart mara
echo "تم التحديث"
EOF
chmod 755 /usr/local/bin/mara-update

# ---------- 11) التحقق ----------
say "التحقق من تشغيل البرنامج"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/status" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ "${OK:-0}" = "1" ] || die "البرنامج لم يبدأ. راجع السجل: journalctl -u mara -n 50"

cat <<EOF

=====================================================
  تم التثبيت بنجاح
  رابط البرنامج:  https://$DOMAIN
  قاعدة البيانات: $DATA_DIR/mara.db
  النسخ الاحتياطية اليومية: $DATA_DIR/backups
  تحديث البرنامج لاحقاً:  sudo mara-update
  سجل البرنامج:  journalctl -u mara -f
=====================================================
إذا لم يفتح الرابط: تأكد من فتح المنفذين 80 و 443
في Security List الخاصة بالشبكة من لوحة Oracle Cloud.
الشهادة تُصدر تلقائياً خلال دقيقة من أول فتح للرابط.
EOF
