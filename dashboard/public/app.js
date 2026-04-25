// laser-helius control center — vanilla JS (no build step)
// Fetches the bot's control API via same-origin /api proxy served by server.cjs.

// ============================== API ==============================

const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
};

// ============================== DOM helpers ==============================

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ============================== Toast system ==============================

const toast = (msg, ok = true) => {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${ok ? "toast-ok" : "toast-err"}`;
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3200);
};

// ============================== Confirm modal ==============================

const confirmDialog = (title, body) =>
  new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    modal.classList.add("show");
    const done = (val) => {
      modal.classList.remove("show");
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
  });

// ============================== Formatters ==============================

const fmtSol = (v) =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(4)}`;

const fmtSolFull = (v) =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(6)} SOL`;

const fmtPnl = (v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(4)}`;
};

const fmtUptime = (sec) => {
  if (!Number.isFinite(sec)) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const fmtAge = (ms) => (Number.isFinite(ms) ? fmtUptime(ms / 1000) : "—");

const fmtRelative = (ms) => {
  if (!ms) return "—";
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
};

const fmtTime = (ms) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour12: false }) : "—";

const short = (s, len = 6) =>
  !s ? "—" : s.length > len * 2 + 1 ? `${s.slice(0, len)}…${s.slice(-4)}` : s;

const perc = (p) =>
  !p ? "—" : `${Math.round(p.p50)} / ${Math.round(p.p95)}ms`;

// ============================== Navigation ==============================

const activateNav = (name) => {
  $$("[data-nav]").forEach((b) => {
    const active = b.dataset.nav === name;
    b.classList.toggle("nav-active", active);
  });
  $$(".panel").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.panel !== name);
  });
  const titles = {
    overview: "Overview",
    positions: "Positions",
    whales: "Whales",
    settings: "Settings",
    history: "History",
  };
  $("#page-title").textContent = titles[name] ?? "Overview";
  closeSidebar();
  if (name === "positions") loadPositions();
  if (name === "whales") loadWhales();
  if (name === "settings") loadSettings();
  if (name === "history") loadHistory();
  if (name === "overview") loadOverview();
};

$$("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => activateNav(b.dataset.nav)),
);

// ============================== Mobile sidebar ==============================

const openSidebar = () => {
  $("#sidebar").classList.remove("-translate-x-full");
  $("#sidebar-overlay").classList.remove("hidden");
};
const closeSidebar = () => {
  if (window.innerWidth >= 768) return;
  $("#sidebar").classList.add("-translate-x-full");
  $("#sidebar-overlay").classList.add("hidden");
};
$("#btn-menu").addEventListener("click", openSidebar);
$("#sidebar-overlay").addEventListener("click", closeSidebar);

// ============================== Overview ==============================

const loadOverview = async () => {
  try {
    const [s, m, h] = await Promise.all([
      api("/status"),
      api("/metrics"),
      api("/history?limit=5"),
    ]);

    // Balance + P&L
    $("#m-baseline").textContent = fmtSol(s.balance.baselineSol);
    $("#m-baseline-ts").textContent = s.balance.baselineCapturedAtMs
      ? `captured ${fmtRelative(s.balance.baselineCapturedAtMs)}`
      : "—";
    $("#m-latest").textContent = fmtSol(s.balance.latestSol);
    $("#m-latest-ts").textContent = s.balance.latestRefreshedAtMs
      ? `fetched ${fmtRelative(s.balance.latestRefreshedAtMs)}`
      : "—";

    const pnl = s.balance.pnlSol;
    const pnlEl = $("#m-pnl");
    pnlEl.textContent = fmtPnl(pnl);
    pnlEl.className = "stat-value";
    if (pnl != null) {
      if (pnl > 0) pnlEl.classList.add("pnl-positive");
      else if (pnl < 0) pnlEl.classList.add("pnl-negative");
    }
    const baseline = s.balance.baselineSol;
    const pct =
      pnl != null && baseline && baseline > 0 ? (pnl / baseline) * 100 : null;
    $("#m-pnl-pct").textContent =
      pct == null
        ? "—"
        : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}% from baseline`;

    // P&L gradient bar (relative to +/-5% band)
    const bar = $("#pnl-bar");
    if (pct != null) {
      const w = Math.min(100, Math.abs(pct) * 20);
      bar.style.width = `${w}%`;
      bar.style.background =
        pct > 0
          ? "linear-gradient(90deg, rgb(16 185 129), rgb(45 212 191))"
          : "linear-gradient(90deg, rgb(244 63 94), rgb(251 113 133))";
    } else {
      bar.style.width = "0%";
    }

    // Trade flow (SELL out - BUY in) from historical counters — independent
    // of balance-delta pnl, so it's meaningful right after a baseline recapture.
    const netFlow = s.balance.netFlowSol;
    const netEl = $("#m-netflow");
    if (netFlow == null || !Number.isFinite(netFlow)) {
      netEl.textContent = "—";
      netEl.className = "font-mono font-medium text-slate-400";
    } else {
      const sign = netFlow > 0 ? "+" : "";
      netEl.textContent = `${sign}${netFlow.toFixed(4)} SOL`;
      netEl.className =
        "font-mono font-medium " +
        (netFlow > 0
          ? "text-emerald-400"
          : netFlow < 0
            ? "text-rose-400"
            : "text-slate-400");
    }

    // Uptime
    $("#m-uptime").textContent = fmtUptime(s.uptimeSec);

    // Trading activity
    $("#m-buy-count").textContent = s.tradeCounts.buy;
    $("#m-sell-count").textContent = s.tradeCounts.sell;
    $("#m-failed").textContent = s.tradeCounts.failed;
    $("#m-positions").textContent = s.positionCount;
    $("#m-whales").textContent = `${s.whaleCount} whales monitored`;
    $("#m-buy-vol").textContent = `${s.volumeSol.bought.toFixed(3)} SOL in`;
    $("#m-sell-vol").textContent = `${s.volumeSol.sold.toFixed(3)} SOL out`;
    const total = s.tradeCounts.buy + s.tradeCounts.sell + s.tradeCounts.failed;
    const success = s.tradeCounts.buy + s.tradeCounts.sell;
    $("#m-success-rate").textContent =
      total > 0 ? `${((success / total) * 100).toFixed(1)}% success rate` : "—";

    // Paused state
    $("#paused-badge").classList.toggle("hidden", !s.paused);
    $("#paused-badge").classList.toggle("inline-flex", s.paused);
    $("#btn-pause").classList.toggle("hidden", s.paused);
    $("#btn-resume").classList.toggle("hidden", !s.paused);

    // Latency bars (0-200ms BUY, 0-300ms SELL for bar scaling)
    $("#m-buy-perc").textContent = perc(m.pipelineBuy);
    $("#m-sell-perc").textContent = perc(m.pipelineSell);
    const buyBar = $("#m-buy-bar");
    const sellBar = $("#m-sell-bar");
    buyBar.style.width = m.pipelineBuy
      ? `${Math.min(100, (m.pipelineBuy.p95 / 200) * 100)}%`
      : "0%";
    sellBar.style.width = m.pipelineSell
      ? `${Math.min(100, (m.pipelineSell.p95 / 300) * 100)}%`
      : "0%";

    // Sidebar footer
    $("#conn-text").textContent = s.paused ? "paused" : "connected";
    $("#conn-dot").classList.toggle("opacity-40", s.paused);
    $("#conn-uptime").textContent = `uptime ${fmtUptime(s.uptimeSec)}`;
    $("#nav-pos-count").textContent = s.positionCount;
    $("#nav-whale-count").textContent = s.whaleCount;

    // Recent trades
    renderRecentTrades(h.history ?? []);
  } catch (e) {
    toast(`status: ${e.message}`, false);
    $("#conn-text").textContent = "offline";
    $("#conn-dot").classList.add("opacity-40");
  }
};

const renderRecentTrades = (history) => {
  const container = $("#recent-trades");
  container.innerHTML = "";
  if (history.length === 0) {
    container.innerHTML = `<div class="empty-state py-6">no trades yet</div>`;
    return;
  }
  history.slice(0, 5).forEach((h) => {
    const row = document.createElement("div");
    row.className = "trade-row";
    const sideCls = h.side === "BUY" ? "badge-buy" : "badge-sell";
    const statusCls =
      h.status === "failed"
        ? "badge-failed"
        : h.status === "confirmed"
          ? "badge-confirmed"
          : "badge-submitted";
    row.innerHTML = `
      <span class="badge ${sideCls}">${h.side}</span>
      <span class="cell-mono truncate">${short(h.token, 6)}</span>
      <span class="flex-1 cell-mono-dim truncate">${short(h.whale, 4)}</span>
      <span class="badge ${statusCls}">${h.status}</span>
      <span class="font-mono text-xs text-slate-400">${(h.sizeSol ?? 0).toFixed(3)} SOL</span>
      <span class="font-mono text-[10px] text-slate-500">${fmtTime(h.ts)}</span>
    `;
    container.appendChild(row);
  });
};

// ============================== Controls ==============================

$("#btn-pause").addEventListener("click", async () => {
  try {
    await api("/pause", { method: "POST" });
    toast("trading paused");
    loadOverview();
  } catch (e) {
    toast(e.message, false);
  }
});

$("#btn-resume").addEventListener("click", async () => {
  try {
    await api("/resume", { method: "POST" });
    toast("trading resumed");
    loadOverview();
  } catch (e) {
    toast(e.message, false);
  }
});

$("#btn-refresh").addEventListener("click", () => {
  const icon = $("#refresh-icon");
  icon.classList.remove("spin");
  void icon.offsetWidth;
  icon.classList.add("spin");
  const active = $$("[data-nav]").find((b) =>
    b.classList.contains("nav-active"),
  );
  activateNav(active?.dataset.nav ?? "overview");
});

$("#btn-refresh-balance").addEventListener("click", async () => {
  try {
    await api("/refresh-balance", { method: "POST" });
    loadOverview();
    toast("balance fetched");
  } catch (e) {
    toast(e.message, false);
  }
});

$("#btn-recapture-baseline").addEventListener("click", async () => {
  const ok = await confirmDialog(
    "Recapture baseline",
    "Reset baseline to current SOL balance? P&L will restart from 0 from this moment. History + counters are preserved.",
  );
  if (!ok) return;
  try {
    const r = await api("/recapture-baseline", { method: "POST" });
    toast(`baseline = ${r.baselineSol.toFixed(4)} SOL`);
    loadOverview();
  } catch (e) {
    toast(e.message, false);
  }
});

// ============================== Positions ==============================

const loadPositions = async () => {
  try {
    const { positions } = await api("/positions");
    const tbody = $("#tbl-positions");
    tbody.innerHTML = "";
    if (positions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2z"/></svg>
        <div>no active positions</div>
      </td></tr>`;
      return;
    }
    positions.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="cell-mono">${short(p.token, 8)}</td>
        <td class="cell-mono-dim">${short(p.owner, 6)}</td>
        <td class="text-sm text-slate-300">${p.buyCount}</td>
        <td class="text-sm text-slate-300">${fmtAge(p.ageMs)}</td>
        <td class="text-right">
          <button data-token="${p.token}" class="btn-force-sell btn-danger-outline">
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 17l5-5-5-5M5 17l5-5-5-5"/></svg>
            Force SELL
          </button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".btn-force-sell").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await confirmDialog(
          "Force SELL position",
          `Sell entire balance of ${btn.dataset.token.slice(0, 8)}… via Jupiter? This releases the cycle lock.`,
        );
        if (!ok) return;
        try {
          await api(`/positions/${btn.dataset.token}/force-sell`, {
            method: "POST",
          });
          toast("force-sell dispatched");
          setTimeout(loadPositions, 1500);
        } catch (e) {
          toast(e.message, false);
        }
      });
    });
  } catch (e) {
    toast(`positions: ${e.message}`, false);
  }
};

// ============================== Whales ==============================

const loadWhales = async () => {
  try {
    const { wallets } = await api("/whales");
    const ul = $("#list-whales");
    $("#whale-total").textContent = `${wallets.length} total`;
    ul.innerHTML = "";
    if (wallets.length === 0) {
      ul.innerHTML = `<li class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>
        <div>no whales configured yet</div>
      </li>`;
      return;
    }
    wallets.forEach((w) => {
      const li = document.createElement("li");
      li.className = "whale-item";
      li.innerHTML = `
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 font-mono text-xs text-emerald-400">
            ${w.slice(0, 2).toUpperCase()}
          </div>
          <code class="break-all font-mono text-xs text-slate-300">${w}</code>
        </div>
        <button data-w="${w}" class="btn-rm-whale btn-danger-outline shrink-0">
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.9 12A2 2 0 0116.1 21H7.9A2 2 0 015.9 19L5 7m5 4v6m4-6v6M10 3h4a2 2 0 012 2v2H8V5a2 2 0 012-2z"/></svg>
          Remove
        </button>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll(".btn-rm-whale").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await confirmDialog(
          "Remove whale",
          `Stop monitoring ${btn.dataset.w.slice(0, 8)}…? Laserstream will reconnect with new filter.`,
        );
        if (!ok) return;
        try {
          const res = await api("/whales", {
            method: "POST",
            body: JSON.stringify({ remove: [btn.dataset.w] }),
          });
          toast(`removed · subscribed to ${res.subscribed}`);
          loadWhales();
          loadOverview();
        } catch (e) {
          toast(e.message, false);
        }
      });
    });
  } catch (e) {
    toast(`whales: ${e.message}`, false);
  }
};

$("#form-add-whale").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const raw = $("#inp-whale").value.trim();
  if (!raw) return;
  // Accept multi-line input; one pubkey per line.
  const add = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const res = await api("/whales", {
      method: "POST",
      body: JSON.stringify({ add }),
    });
    $("#inp-whale").value = "";
    toast(`added ${res.added.length} · subscribed to ${res.subscribed}`);
    loadWhales();
    loadOverview();
  } catch (e) {
    toast(e.message, false);
  }
});

// ============================== Settings ==============================

const loadSettings = async () => {
  try {
    const status = await api("/status");
    const s = status.trading;
    const form = $("#form-settings");
    form.slippageBps.value = s.slippageBps ?? "";
    form.fixedBuyAmountSol.value = s.fixedBuyAmountSol ?? "";
    form.minWhaleBuyAmountSol.value = s.minWhaleBuyAmountSol ?? "";
    form.rebuyMaxCount.value = s.rebuyMaxCount ?? "";
    form.rebuyAmountSize.value = s.rebuyAmountSize ?? 0;
    form.autoSellTtlMin.value = s.autoSellTtlMs
      ? Math.round(s.autoSellTtlMs / 60000)
      : "";
    form.rebuyEnabled.checked = !!s.rebuyEnabled;
    form.followWhaleSell.checked = !!s.followWhaleSell;

    const overrides = await api("/settings");
    $("#settings-updated").textContent = overrides.updatedAtMs
      ? `last saved ${fmtRelative(overrides.updatedAtMs)}`
      : "no overrides saved yet — using .env defaults";
  } catch (e) {
    toast(`settings: ${e.message}`, false);
  }
};

$("#form-settings").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const patch = {
    slippageBps: Number(f.slippageBps.value),
    fixedBuyAmountSol: Number(f.fixedBuyAmountSol.value),
    minWhaleBuyAmountSol: Number(f.minWhaleBuyAmountSol.value),
    rebuyMaxCount: Number(f.rebuyMaxCount.value),
    rebuyAmountSize: Number(f.rebuyAmountSize.value),
    autoSellTtlMs: Number(f.autoSellTtlMin.value) * 60000,
    rebuyEnabled: f.rebuyEnabled.checked,
    followWhaleSell: f.followWhaleSell.checked,
  };
  try {
    await api("/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    toast("settings applied live");
    loadSettings();
    loadOverview();
  } catch (e) {
    toast(e.message, false);
  }
});

// ============================== History ==============================

const loadHistory = async () => {
  try {
    const { history } = await api("/history?limit=50");
    const tbody = $("#tbl-history");
    tbody.innerHTML = "";
    if (history.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        <div>no trades yet</div>
      </td></tr>`;
      return;
    }
    history.forEach((h) => {
      const tr = document.createElement("tr");
      const sideCls = h.side === "BUY" ? "badge-buy" : "badge-sell";
      const statusCls =
        h.status === "failed"
          ? "badge-failed"
          : h.status === "confirmed"
            ? "badge-confirmed"
            : "badge-submitted";
      tr.innerHTML = `
        <td class="cell-mono-dim">${fmtTime(h.ts)}</td>
        <td><span class="badge ${sideCls}">${h.side}</span></td>
        <td><span class="badge ${statusCls}">${h.status}</span></td>
        <td class="cell-mono">${short(h.token, 8)}</td>
        <td class="cell-mono-dim">${short(h.whale, 6)}</td>
        <td class="text-right font-mono text-sm text-slate-300">${(h.sizeSol ?? 0).toFixed(3)}</td>
        <td class="text-right font-mono text-sm text-slate-400">${h.pipelineMs ?? "—"}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    toast(`history: ${e.message}`, false);
  }
};

// ============================== Manual history refresh ==============================

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("#btn-refresh-history");
  if (!btn) return;
  btn.disabled = true;
  const label = btn.querySelector("svg");
  label?.classList.add("spin");
  try {
    const r = await api("/refresh-history", { method: "POST" });
    toast(
      `helius fetch: +${r.added} new, ${r.skipped} dup (${r.fetched} total)`,
    );
    loadHistory();
    loadOverview();
  } catch (e) {
    toast(e.message, false);
  } finally {
    btn.disabled = false;
    setTimeout(() => label?.classList.remove("spin"), 600);
  }
});

// ============================== Auto-refresh ==============================

setInterval(() => {
  const active = $$("[data-nav]").find((b) =>
    b.classList.contains("nav-active"),
  );
  if (!active || active.dataset.nav === "overview") loadOverview();
}, 5000);

// ============================== Boot ==============================

loadOverview();
activateNav("overview");
