# CLAUDE.md — laser-helius

> Petunjuk repo-spesifik untuk Claude Code. Bahasa campur ID/EN sesuai gaya operator. **Tujuan utama: bot whale copytrade Solana dengan latency serendah mungkin.**

---

## 0. Tone & Kontrak Kerja dengan Operator

- Bahasa: Indonesia. Boleh selipan istilah teknis EN.
- **Jangan asumsi** — kalau ragu, baca file dulu (laserstream-preprocessed.ts, engine, execution, perf/*).
- Sebelum klaim "selesai", **wajib tampilkan bukti**: log line, file path, atau diff. **Tidak boleh ngira-ngira.**
- Tambahkan `console.error` / debug log saat menelusuri masalah baru — operator membutuhkan bukti, bukan tebakan.
- Repo **belum di-git**. Setiap perubahan besar: minta operator backup `src/` dulu (atau init git lokal) sebelum lanjut.

## 1. Aturan Konfigurasi (Penting)

1. **Bot baca `.env`, BUKAN `.env.example`.** Kalau ubah variabel runtime, edit `.env`. Update `.env.example` cuma untuk dokumentasi template. Jangan pernah cuma update `.env.example` lalu klaim selesai.
2. **Whale wallet, jupiterApiKeys, rpcUrls** ada di `configuration.json` — bukan di `.env`. Field `whaleWallets` boleh di-reload runtime via control API.
3. **Secrets di `.env`** (BOT_PRIVATE_KEY, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN). **Jangan commit, jangan paste ke chat, jangan masukin file lain.**
4. Setelah edit `.env` atau `configuration.json`: **wajib** restart proses — `pm2 reload laser-helius` (atau `pm2 restart`). Tanpa reload, perubahan tidak aktif.

## 2. Arsitektur Hot Path

```
Helius Laserstream gRPC (preprocessed)
  └─ src/listener/laserstream-preprocessed.ts
      └─ decode-instruction.ts  (decode dari ix bytes, no meta)
          ├─ speculativeQuoteForBuy()  ← Jupiter prebuild paralel (engine)
          ├─ speculativeQuoteForSell()
          ├─ speculativelySubscribePool() ← gRPC pool stream
          └─ processor.handleWhaleTx()
              └─ engine.handleSignal()
                  ├─ direct-pump SDK (PUMPFUN/PUMPSWAP)
                  └─ Jupiter v6 swap-instructions
                      └─ ExecutionEngine.execute()
                          ├─ chooseTipLamports()
                          ├─ tx.sign()
                          └─ sendMultiRace()  ← Helius+Jito+N×RPC paralel
                              └─ Promise.any → first wins
```

**Layanan latar (warm cache):**
- `BlockhashCache` 2s refresh
- `PriorityFeeCache` 2s refresh (Helius getPriorityFeeEstimate)
- `WalletStateCache`, `PumpStateCache`, `AltCache`, `PersistentWsolTracker`
- `PoolAccountStream` (gRPC pool subscribe)
- `RpcHealthChecker` (probe per N ms, exclude lambat dari race)

**Anggaran latency target (sinyal whale → tx submit):**
- Decode (gRPC parse + ix decode): 1–5 ms
- Speculative quote inflight saat handler jalan: 5–10 ms remaining (idealnya cache HIT = 0 ms)
- Sign + serialize: 2–5 ms
- Tip inject: 1–3 ms
- Send (network ke Helius SGP / Jito SGP): 10–30 ms
- **Total target: < 60 ms dari ingest → sig submitted** (saat cache HIT). Cache MISS bisa 200–500 ms karena Jupiter round-trip.

## 3. Audit — Kelemahan & Prioritas Update (per 2026-04-25)

Periksa & perbaiki dengan urutan ini. Setiap item: tampilkan bukti sebelum/sesudah (log line + diff).

### TIER 1 — Latency / Landing Rate (kerjakan dulu)

1. **Priority fee floor terlalu rendah.** Log `pm2-out.log` menunjukkan `raw=10000` µlamports terus menerus.
   - Naikkan `minMicroLamports` di `engine/index.ts` PriorityFeeCache (sekarang 1k) ke `50000–100000`.
   - Atau set env baru `PRIORITY_FEE_MIN_MICROLAMPORTS=50000` dan teruskan ke constructor.
   - Validasi: log harus mulai mencatat angka ≥ 50000.

2. **Decoder Jupiter v6 V2** belum lengkap. Memory `project_jupiter_v6_v2_instructions.md` mencatat discriminator on-chain only. Lengkapi handler `route_v2`, `shared_accounts_route_v2`, `exact_out_route_v2`, `shared_accounts_exact_out_route_v2` di `decode-instruction.ts` (sudah ada konstanta — pastikan path eksekusi tidak return null tanpa parsing).
   - Validasi: jalankan `node test-jup-v2-decoder.mjs`. Whale Jupiter SELL/BUY tidak boleh muncul lagi di `instruction_drop.jsonl` dengan reason `no_recognized_swap_ix` saat program id = `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`.

3. **Reduce decode drop noise.** Pre-filter di laserstream `accountInclude` — hanya subscribe txs yang menyentuh program PUMPFUN/PUMPSWAP/RAYDIUM/JUPITER, bukan semua tx whale (System transfer, ComputeBudget-only, Magiceden, dll). Lihat opsi `subscribePreprocessed` di `laserstream-preprocessed.ts`.
   - Validasi: `instruction_drop.jsonl` size turun > 80%.

4. **JUPITER_INTEGRATION_MODE** sekarang `metis_instructions` (2 round-trip). Untuk lowest-latency BUY non-pump, coba `order_v2` (single GET /order dengan taker → tx siap). Operator harus toggle di `.env` lalu reload.
   - Trade-off: kontrol lokal lebih rendah, tapi -50 hingga -150ms per BUY.

5. **Native bigint binding.** `bigint: Failed to load bindings, pure JS will be used` muncul di pm2-error. Jalankan `npm rebuild bigint-buffer` (atau `npm rebuild`). Jika masih gagal di Linux/VPS, install `build-essential python3` dulu.

### TIER 2 — Reliability / Coverage

6. **Single laserstream endpoint.** Tambahkan failover: di `laserstream-preprocessed.ts`, simpan list endpoint (sgp + fra/tyo). On reconnect attempt > 3 → switch ke endpoint berikutnya. Helius mengizinkan multi-region.

7. **Multi-feed redundancy.** Package `@triton-one/yellowstone-grpc` sudah ada di deps tapi unused. Pertimbangkan dual-feed (Laserstream primary + Yellowstone backup) dengan dedupe by signature di processor. Tujuannya: kalau salah satu hiccup, signal tidak hilang.

8. **Background confirm deadline.** Log: `confirm deadline exceeded (12049ms)`. Override jadi short-circuit: kalau 5s belum ack via WSS, polling getSignatureStatus 2 RPC paralel (race). Lihat `confirmInBackground` di `execution/index.ts`.

9. **Tip adaptif.** Tip sekarang fix (BUY 500k / SELL 800k). Tambahkan rolling-window tracker: kalau revert rate > 30% dalam 5 menit terakhir → tip ×1.5 untuk 10 send berikutnya. State di `RuntimeState`.

### TIER 3 — Operator Quality

10. **Telegram alert** untuk SOL rendah (< reserve), priority fee staleness > 30s, healthchecker disable > 50% endpoints, instruction drop rate > 50/menit. Hook ke `runtime/sla-alert.ts` (sudah ada — extend).

11. **Init git lokal.** `git init && git add -A && git commit -m "snapshot 2026-04-25"`. Tanpa git, susah rollback. **Jangan push ke remote** — repo punya secrets.

12. **Test coverage** di `tests/` minim. Tambahkan minimum: decoder PUMPFUN buy/sell + Jupiter v6 v1/v2 + edge cases (versioned tx dengan ALT). Test pakai vitest yang sudah terinstall.

### TIER 4 — Eksperimental

13. **Multi-race endpoint pruning.** 7 endpoint per send = bandwidth × 7. Coba: race hanya top-3 healthy by recent p50 RTT. State di `RpcHealthChecker`.

14. **CU limit dinamis.** Jupiter v2 `dynamicComputeUnitLimit=true`. Pastikan diaktifkan di JupiterClient.buildSwapTransactionWithQuote saat path metis. Jangan over-allocate (tip waste).

15. **Pre-simulate untuk fresh tokens.** Saat BUY token baru pertama kali, simulate tx pertama untuk deteksi InstructionError sebelum mass-spam send race.

## 4. Workflow Update Repo (untuk Claude)

Sebelum menyentuh hot-path file (`listener/`, `engine/`, `execution/`, `perf/`), ikuti urutan ini:

1. **Baca dulu**: `src/main.ts`, file target, dan minimal 1 file dependency. Jangan edit blind.
2. **Bukti masalah**: tampilkan log line atau diff yang menunjukkan masalah ada (dari `logs/pm2-out.log`, `logs/pm2-error.log`, `logs/instruction_drop.jsonl`).
3. **Buat plan**: 1–3 sentence — apa yang diubah, file mana, hasil yang diharapkan.
4. **Edit minimal**: jangan refactor sambil lalu. Jangan tambah comment naratif. Jangan `unwrap()`/`!` di hot path TS.
5. **Build**: `npm run build` (`tsc -p tsconfig.json`). Wajib zero error TypeScript.
6. **Test bila ada**: `npm test` (vitest).
7. **Reload**: operator akan jalankan `pm2 reload laser-helius`. Claude hanya menyarankan.
8. **Validasi runtime**: tunjukkan operator log line apa yang harus dia cari (mis. `[priority-fee] refreshed 75000 µlamports`).

### Aturan keras (jangan dilanggar)

- **Jangan ubah** `BOT_PRIVATE_KEY`, `HELIUS_API_KEY`, atau `TELEGRAM_*` tanpa permintaan eksplisit.
- **Jangan tambah dependency** tanpa nyatakan alasan + ukuran (mis. "@solana/spl-token-swap +120KB"). User running di VPS, setiap MB peduli.
- **Jangan blocking call di hot path**: tidak ada `await` ke RPC sinkron di `listener` callback path. Pakai cache atau speculative.
- **Jangan EventEmitter di hot path** (sudah pakai direct callback — pertahankan).
- **Jangan Telegram di hot path**: notifyResult harus `void .catch()`, sudah benar.
- **Jangan kirim tx tanpa tip** kalau senderMode=helius (Helius Sender minimum 200_000 lamports — sudah di-clamp di code).
- **Jangan recompute PDA atau ALT** per tx — selalu via cache.
- **Jangan log JSON.stringify** ke console di hot path — pakai console.log/warn line ringkas, atau queue ke async file logger.

## 5. Build, Run, Diagnose

```bash
# Dev
npm run dev                          # tsx watch

# Production
npm run build                        # tsc → dist/
pm2 start ecosystem.config.cjs       # bot + dashboard
pm2 reload laser-helius              # hot-reload bot only
pm2 logs laser-helius                # tail bot logs
pm2 stop laser-dashboard             # stop UI saja, trading lanjut

# Diagnose
tail -f logs/pm2-out.log             # live latency lines
tail -f logs/instruction_drop.jsonl  # decoder gagal kenali tx
tail -f logs/pm2-error.log           # error & warning

# Test decoder Jupiter v2
node test-jup-v2-decoder.mjs

# Test direct paths
npm run test:direct-paths
```

### Cara baca `[latency]` line

```
[latency] pipeline=42 ingestDetect=3 ingestSignal=8 ingestTotal=12
         signalQueue=2 execTotal=30 quoteBuild=0 sign=2 serialize=1
         tipInject=1 send=18 confirm=0 status=submitted feed=laserstream-pp
         sender=helius whale=2NAg...
```
- `pipeline` total dari ingest sampai submit
- `quoteBuild=0` artinya prebuild cache HIT — paling cepat
- `quoteBuild=200+` artinya MISS, Jupiter round-trip
- `send>50` artinya endpoint lambat — cek healthchecker

### Cara baca `instruction_drop.jsonl`

Tiap line = whale tx yang di-decode tapi tidak ada swap ix yang dikenali. Field `instructions[].programId + discriminatorHex` tunjukkan apa yang aktual. Kalau program id = Jupiter (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) dan disc = `bb64facc31c4af14` (route_v2) → **decoder bug, prioritas fix**.

## 6. Direktori Penting

| Path | Isi |
|------|-----|
| `src/main.ts` | Wiring lengkap (cache init, listener start, engine, executor, runtime) |
| `src/listener/laserstream-preprocessed.ts` | Helius gRPC subscribe + reconnect |
| `src/listener/decode-instruction.ts` | Decode ix bytes → BUY/SELL signal |
| `src/engine/index.ts` | Speculative quote, prebuild cache, direct-pump dispatch |
| `src/execution/index.ts` | Tip injection, sign, multi-sender race, confirm |
| `src/execution/jupiter.ts` | Jupiter v6 client (quote + swap-instructions / order_v2) |
| `src/execution/direct-pump.ts` | Pump.fun / PumpSwap SDK execution path |
| `src/perf/*.ts` | Cache layer (blockhash, alt, wallet, pump-state, priority-fee) |
| `src/perf/instruction-drop-log.ts` | Buffer drop log → `logs/instruction_drop.jsonl` |
| `src/runtime/control-server.ts` | Dashboard control HTTP (port 9092 lokal) |
| `configuration.json` | Whale wallets, Jupiter API keys, RPC URLs (live-reload) |
| `.env` | Secrets + tunable runtime config (RUNTIME) |
| `logs/` | pm2-out, pm2-error, instruction_drop, dashboard |
| `dashboard/` | UI server.cjs + static (separate process) |
| `whale-profile.ts` + `.json` | Tooling whale analyzer (offline) |

## 7. Memory Hooks

- Memory `feedback_env_file.md`: bot baca `.env`, **bukan** `.env.example`.
- Memory `project_jupiter_v6_v2_instructions.md`: discriminator V2 hanya ada di on-chain IDL — package public stale. Lihat sebelum modify decoder Jupiter.

Tambahkan memory baru kalau ketemu:
- konvensi proyek non-obvious
- perilaku yang sudah disetujui operator (saved confirmations)
- patokan latency yang dianggap "cukup" oleh operator

## 8. Cara Menambah Fitur Baru (mis. arbitrage, MEV, multi-leg)

Operator pernah tanya soal MEV/arbitrage 1-tx. Pertimbangkan **sebelum** koding:
1. Apakah feed sudah cukup cepat? (Laserstream preprocessed = ya, kalau tanpa Jito bundle masih bisa → race ke beberapa sender).
2. Apakah needed extra signer/program? — kalau perlu Jito Searcher auth, **operator tidak punya**. Cari jalur alternatif (Helius Sender + tip tinggi + multi-RPC race).
3. Risiko backrun: kalau bot kalah landing → exposed slippage. Pasang slippage tight + `EXEC_BUY_NO_FALLBACK=true`.

Stage:
- **R&D**: tulis script di `src/scripts/` (off hot path), test di mainnet kecil.
- **Wire-in**: kalau hasil bagus, integrate ke `engine` atau `execution`. Jangan campur ke listener (hot path harus tetap < 5ms).

---

**Last review:** 2026-04-25 — audit dilakukan dengan operator log + source. Update file ini ketika arsitektur berubah signifikan.
