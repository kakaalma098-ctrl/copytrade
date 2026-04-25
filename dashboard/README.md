# laser-helius dashboard

Web UI untuk monitor + kontrol bot tanpa SSH/PM2.

## Arsitektur

```
Browser (any device)
    │  http://<vps>:3000
    ▼
laser-dashboard (Node, this folder)  ← separate PM2 process
    │  reverse-proxy /api/*  →  127.0.0.1:9092
    ▼
laser-helius (bot)                   ← hot path UNTOUCHED
    └─ control API on :9092 (localhost-only)
```

Dashboard berjalan **proses terpisah dari bot** — HTTP handling tidak mencuri event-loop bot. Bot's hot path tetap pada latency target.

## Fitur

- **Overview**: baseline/latest SOL, P&L, uptime, trade counts, BUY/SELL pipeline p50/p95.
- **Positions**: aktif cycle + umur + **force SELL** button.
- **Whales**: tambah/hapus whale wallet — auto reconnect Laserstream subscription.
- **Settings**: slippage, fixed BUY SOL, min whale BUY, rebuy max, auto-sell TTL, follow whale SELL — disimpan ke `state/settings.json`, survive restart.
- **History**: 50 trade terakhir (in-memory ring buffer).
- **Pause/Resume**: stop trading tanpa matikan listener (whale event tetap tercatat metrics).

## Jalanin

Dashboard otomatis ikut `pm2 start ecosystem.config.cjs` di repo root. Kalau mau jalanin standalone:

```bash
cd dashboard
node server.cjs
# → http://0.0.0.0:3000
```

Access: `http://<vps-ip>:3000`

## Environment override

Semua via env var ke `dashboard/server.cjs`:

| Var | Default | Purpose |
|---|---|---|
| `DASHBOARD_PORT` | `3000` | Listen port |
| `DASHBOARD_BIND` | `0.0.0.0` | Bind host |
| `CONTROL_API_HOST` | `127.0.0.1` | Bot control API host |
| `CONTROL_API_PORT` | `9092` | Bot control API port |
| `CONTROL_API_TOKEN` | `""` | Shared secret (harus match bot `.env` `CONTROL_API_TOKEN`) |

## Security

Default: bot control API **bind 127.0.0.1** — tidak accessible dari luar VPS. Dashboard HTTP (:3000) menerima koneksi internet tapi tidak bisa bypass bot's localhost binding.

### Option A — LAN/VPN only (simplest)

Biarkan dashboard `DASHBOARD_BIND=0.0.0.0`, proteksi via:
- VPS firewall rule: only allow port 3000 from your IP
- Atau SSH tunnel: `ssh -L 3000:localhost:3000 vps` → akses via `http://localhost:3000`

### Option B — public web + token

1. Set `CONTROL_API_TOKEN=<random-long-string>` di `.env` bot.
2. Mirror nilai sama di `ecosystem.config.cjs` → `laser-dashboard` env.
3. Setup nginx/caddy reverse proxy dengan TLS di depan dashboard.

## API endpoints

| Method | Path | Body |
|---|---|---|
| GET | `/api/health` | — |
| GET | `/api/status` | — |
| POST | `/api/pause` | — |
| POST | `/api/resume` | — |
| GET | `/api/whales` | — |
| POST | `/api/whales` | `{ add?: string[], remove?: string[] }` |
| GET | `/api/positions` | — |
| POST | `/api/positions/:token/force-sell` | — |
| GET | `/api/history?limit=50` | — |
| GET | `/api/settings` | — |
| POST | `/api/settings` | `{ slippageBps?, fixedBuyAmountSol?, ... }` |
| GET | `/api/metrics` | — |
| POST | `/api/refresh-balance` | — |

CORS wide-open dari bot control server — memudahkan dev. Untuk prod, restrict via reverse proxy.
