#!/usr/bin/env bash
# ==============================================================================
# laser-helius dashboard one-shot deploy
# ------------------------------------------------------------------------------
# Usage (on VPS, run as root or with sudo):
#   bash deploy.sh yourdomain.com
#   # or via env:
#   DOMAIN=yourdomain.com EMAIL=you@mail.com bash deploy.sh
#
# What it does:
#   1. Install nginx + certbot (Ubuntu/Debian) if missing
#   2. Write /etc/nginx/sites-available/<domain> reverse-proxy → 127.0.0.1:3000
#   3. Obtain Let's Encrypt cert via certbot (http-01 challenge)
#   4. Enable HTTPS + HSTS, redirect HTTP → HTTPS
#   5. (Optional) basic-auth on the dashboard UI
#   6. Open ports 80/443 on ufw if active
#   7. Verify PM2 processes are running
#
# Re-running is safe (idempotent).
# ==============================================================================

set -euo pipefail

# ---------- config ----------
DOMAIN="alma.gmgn.online"
EMAIL="kakaalma369@gmail.com"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
AUTH_USER="${AUTH_USER:-admin}"
AUTH_PASS="${AUTH_PASS:-}"                  # leave empty to skip basic-auth

# ---------- helpers ----------
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
info()  { echo "${BLUE}[i]${RESET} $*"; }
ok()    { echo "${GREEN}[✓]${RESET} $*"; }
warn()  { echo "${YELLOW}[!]${RESET} $*"; }
fail()  { echo "${RED}[✗]${RESET} $*" >&2; exit 1; }
need_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "script harus dijalankan sebagai root: sudo bash deploy.sh"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

prompt_if_empty() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local current="${!var_name:-}"
  if [[ -z "$current" ]]; then
    if [[ -n "$default" ]]; then
      read -r -p "$prompt [$default]: " val
      val="${val:-$default}"
    else
      read -r -p "$prompt: " val
    fi
    printf -v "$var_name" '%s' "$val"
  fi
}

# ---------- preflight ----------
need_root

info "validasi input..."
prompt_if_empty DOMAIN "Domain (e.g. bot.example.com)"
[[ -z "$DOMAIN" ]] && fail "DOMAIN wajib"
if ! echo "$DOMAIN" | grep -Eq '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
  fail "DOMAIN tidak valid: $DOMAIN"
fi

prompt_if_empty EMAIL "Email untuk notifikasi Let's Encrypt"
[[ -z "$EMAIL" ]] && fail "EMAIL wajib (untuk renewal notice)"

info "target: https://$DOMAIN → http://127.0.0.1:$DASHBOARD_PORT"

# ---------- DNS sanity check ----------
info "cek DNS A record..."
RESOLVED_IPS="$(getent hosts "$DOMAIN" | awk '{print $1}' || true)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || echo '')"
if [[ -n "$RESOLVED_IPS" && -n "$PUBLIC_IP" ]]; then
  if echo "$RESOLVED_IPS" | grep -qx "$PUBLIC_IP"; then
    ok "DNS sudah mengarah ke VPS ($PUBLIC_IP)"
  else
    warn "DNS $DOMAIN → $RESOLVED_IPS | VPS IP → $PUBLIC_IP"
    warn "certbot HTTP challenge akan gagal bila A record belum propagate."
    read -r -p "Lanjutkan? [y/N] " ans
    [[ "${ans,,}" == "y" ]] || fail "dibatalkan"
  fi
else
  warn "tidak bisa memverifikasi DNS (getent/ipify gagal) — lanjut"
fi

# ---------- install packages ----------
install_packages() {
  if have apt-get; then
    info "apt update + install nginx certbot python3-certbot-nginx..."
    DEBIAN_FRONTEND=noninteractive apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      nginx certbot python3-certbot-nginx apache2-utils curl
  elif have dnf; then
    info "dnf install nginx certbot ..."
    dnf install -y nginx certbot python3-certbot-nginx httpd-tools curl
  elif have yum; then
    info "yum install nginx certbot ..."
    yum install -y epel-release
    yum install -y nginx certbot python3-certbot-nginx httpd-tools curl
  else
    fail "package manager tidak didukung (butuh apt/dnf/yum)"
  fi
}
install_packages

# ---------- basic-auth (optional) ----------
HTPASSWD_FILE="/etc/nginx/.htpasswd-laser-helius"
if [[ -n "$AUTH_PASS" ]]; then
  info "setup basic-auth user=$AUTH_USER..."
  if have htpasswd; then
    htpasswd -bc "$HTPASSWD_FILE" "$AUTH_USER" "$AUTH_PASS" >/dev/null
  else
    # fallback: openssl apr1
    HASH="$(openssl passwd -apr1 "$AUTH_PASS")"
    echo "${AUTH_USER}:${HASH}" > "$HTPASSWD_FILE"
  fi
  chmod 640 "$HTPASSWD_FILE"
  chown root:www-data "$HTPASSWD_FILE" 2>/dev/null || true
  AUTH_SNIPPET="auth_basic \"Copytrading\"; auth_basic_user_file $HTPASSWD_FILE;"
  ok "basic-auth enabled"
else
  warn "AUTH_PASS kosong — dashboard UI tidak pakai login nginx (hanya CONTROL_API_TOKEN)"
  AUTH_SNIPPET=""
fi

# ---------- write nginx site ----------
NGINX_SITE="/etc/nginx/sites-available/laser-helius"
NGINX_LINK="/etc/nginx/sites-enabled/laser-helius"

# Remove default "Welcome to nginx" page if present
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

info "tulis nginx site config → $NGINX_SITE"

cat > "$NGINX_SITE" <<NGINX
# laser-helius dashboard — reverse proxy ke localhost:${DASHBOARD_PORT}
# HTTP: redirect to HTTPS (certbot handles the port 80 ACME challenge first,
# then managed_certificate mode upgrades this block — this is the pre-cert shape).
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Allow ACME challenge before redirect.
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    # Placeholders — certbot replaces with real cert paths after issuance.
    # Use snakeoil/self-signed on first run so nginx can start before certbot.
    ssl_certificate     /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:!aNULL:!MD5:!DSS';
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;

    client_max_body_size 1m;

    ${AUTH_SNIPPET}

    location / {
        proxy_pass http://127.0.0.1:${DASHBOARD_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
        # Disable buffering so /api/* streams stay snappy.
        proxy_buffering off;
    }
}
NGINX

# Ensure snakeoil cert exists so nginx doesn't fail on first start.
if ! [[ -f /etc/ssl/certs/ssl-cert-snakeoil.pem ]]; then
  info "generate self-signed bootstrap cert..."
  mkdir -p /etc/ssl/private /etc/ssl/certs
  openssl req -x509 -nodes -newkey rsa:2048 \
    -subj "/CN=localhost" \
    -keyout /etc/ssl/private/ssl-cert-snakeoil.key \
    -out /etc/ssl/certs/ssl-cert-snakeoil.pem -days 30 >/dev/null 2>&1 || true
  chmod 600 /etc/ssl/private/ssl-cert-snakeoil.key
fi

mkdir -p /var/www/html

ln -sf "$NGINX_SITE" "$NGINX_LINK"

info "test nginx config..."
nginx -t
ok "nginx config valid"

info "reload nginx..."
systemctl reload nginx || systemctl restart nginx
ok "nginx reloaded"

# ---------- firewall ----------
if have ufw && ufw status | grep -q "Status: active"; then
  info "ufw aktif → allow 80/443..."
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  ok "firewall: 80/443 allowed"
fi

# ---------- certbot ----------
info "jalankan certbot --nginx (Let's Encrypt)..."
certbot --nginx \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect \
  -d "$DOMAIN" \
  || fail "certbot gagal — cek DNS A record $DOMAIN → VPS IP + port 80 terbuka"
ok "SSL certificate issued & nginx auto-configured"

# ---------- auto-renewal test ----------
info "test auto-renewal (dry run)..."
if certbot renew --dry-run >/dev/null 2>&1; then
  ok "auto-renewal siap (cron sudah dipasang oleh certbot)"
else
  warn "dry-run gagal — certificate tetap aktif, tapi renewal perlu dicek manual"
fi

# ---------- PM2 health ----------
info "cek PM2 proses..."
if have pm2; then
  pm2 list || true
  if pm2 list 2>/dev/null | grep -q "laser-dashboard"; then
    ok "laser-dashboard online"
  else
    warn "laser-dashboard tidak ter-list di PM2 — jalankan:"
    warn "  pm2 start ecosystem.config.cjs && pm2 save"
  fi
  if pm2 list 2>/dev/null | grep -q "laser-helius"; then
    ok "laser-helius online"
  else
    warn "laser-helius tidak ter-list di PM2 — jalankan:"
    warn "  pm2 start ecosystem.config.cjs && pm2 save"
  fi
else
  warn "pm2 tidak terinstall — install via: npm install -g pm2"
fi

# ---------- final verification ----------
info "verifikasi endpoint..."
sleep 2
if curl -fsS --max-time 10 -o /dev/null "https://$DOMAIN/"; then
  ok "dashboard live: https://$DOMAIN"
else
  warn "HTTPS check gagal — coba buka di browser manual"
fi

cat <<SUMMARY

${GREEN}════════════════════════════════════════════════════════════════${RESET}
  ${GREEN}DEPLOY SELESAI${RESET}

  Dashboard:       ${BLUE}https://$DOMAIN${RESET}
  Basic auth:      $([ -n "$AUTH_PASS" ] && echo "user=$AUTH_USER" || echo "disabled")
  Control API:     127.0.0.1:9092 (localhost-only, token-protected)
  nginx config:    $NGINX_SITE
  SSL:             /etc/letsencrypt/live/$DOMAIN/
  Renewal:         certbot auto-renewal aktif

  Perintah berguna:
    tail nginx access :  tail -f /var/log/nginx/access.log
    reload nginx      :  systemctl reload nginx
    renew cert manual :  certbot renew
    pm2 status        :  pm2 list
    pm2 logs          :  pm2 logs laser-helius --lines 100
${GREEN}════════════════════════════════════════════════════════════════${RESET}

SUMMARY
