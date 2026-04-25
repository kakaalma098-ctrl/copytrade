# laser-helius

Bot whale copytrade Solana berbasis Helius Laserstream dengan target latency serendah mungkin.

## Ringkasan

- Feed utama: Helius Laserstream preprocessed transaction stream.
- Decoder: instruction-level parsing untuk Pump.fun, PumpSwap, Raydium, dan Jupiter.
- Eksekusi: direct pump path + Jupiter path dengan multi-sender race (Helius, Jito, RPC).
- Fokus utama: landing rate dan latency ingest -> submit.

## Arsitektur singkat

1. `src/listener/laserstream-preprocessed.ts` ingest transaksi whale.
2. `src/listener/decode-instruction.ts` decode instruction menjadi signal BUY/SELL.
3. `src/processor/index.ts` normalisasi signal.
4. `src/engine/index.ts` quote/prebuild + route eksekusi.
5. `src/execution/index.ts` sign, tip inject, dan send race.

## Prasyarat

- Node.js 20+ (disarankan LTS terbaru)
- npm
- PM2 (untuk mode production)

## Konfigurasi

### 1) File environment

Bot membaca `.env` untuk runtime secrets dan runtime flags.

Contoh setup awal:

- copy `.env.example` menjadi `.env`
- isi nilai berikut minimal:
  - `BOT_PRIVATE_KEY`
  - `HELIUS_API_KEY`
  - `TELEGRAM_BOT_TOKEN` (opsional jika notifikasi dipakai)

### 2) File konfigurasi trading

`configuration.json` dipakai untuk data operasional, termasuk:

- `whaleWallets`
- `jupiterApiKeys`
- `rpcUrls`

Catatan: setelah ubah `.env` atau `configuration.json`, reload proses agar perubahan aktif.

## Menjalankan proyek

### Development

- install dependency: `npm install`
- jalankan watch mode: `npm run dev`

### Build & run

- build: `npm run build`
- start hasil build: `npm run start`

### PM2 (production)

- start service: `pm2 start ecosystem.config.cjs`
- reload bot: `pm2 reload laser-helius`
- lihat log bot: `pm2 logs laser-helius`
- stop dashboard saja: `pm2 stop laser-dashboard`

## Testing

- unit/integration test: `npm test`
- test watch: `npm run test:watch`
- coverage: `npm run test:coverage`
- direct-path test: `npm run test:direct-paths`

## Monitoring dan log

Folder `logs/` berisi log runtime utama:

- `pm2-out.log`
- `pm2-error.log`
- `instruction_drop.jsonl`
- `dashboard-out.log`

Untuk analisis cepat:

- tail out log: `tail -f logs/pm2-out.log`
- tail decode drop: `tail -f logs/instruction_drop.jsonl`
- tail error log: `tail -f logs/pm2-error.log`

## Struktur direktori penting

- `src/listener/` ingest + decoding
- `src/engine/` orchestration signal -> quote -> execute
- `src/execution/` sender, tip, Jupiter/direct-pump execution
- `src/perf/` cache, healthcheck, latency helper
- `src/runtime/` control API, metrics, runtime state
- `dashboard/` web dashboard terpisah
- `tests/` unit/integration tests

## Keamanan dan operasional

- Jangan commit secrets (`.env`, private keys, token API).
- Validasi perubahan dengan build dan test sebelum deploy.
- Untuk perubahan hot path, utamakan edit minimal dan bukti dari log sebelum/sesudah.

## Catatan Git

Repository ini sudah diinisialisasi. Push pertama menggunakan branch `master` ke remote `origin`.

Jika ingin mengikuti naming branch modern:

- rename branch lokal: `git branch -m main`
- push dan set upstream: `git push -u origin main`
- ubah default branch di GitHub, lalu hapus branch lama bila perlu.
