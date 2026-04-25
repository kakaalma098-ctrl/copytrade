import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignalProcessor } from "../src/processor/index.js";
import type { TradeSignal } from "../src/types/index.js";
import { runtimeState } from "../src/runtime/runtime-state.js";
import {
  buildAppConfig,
  buildRawBuy,
  buildRawSell,
} from "./fixtures/app-config.js";

const TOKEN_X = "TokenX";
const TOKEN_Y = "TokenY";
const WHALE_A = "WhaleA";
const WHALE_B = "WhaleB";

const collect = (proc: SignalProcessor): TradeSignal[] => {
  const out: TradeSignal[] = [];
  proc.setOnSignal((s) => out.push(s));
  return out;
};

beforeEach(() => {
  runtimeState.tradingPaused = false;
});

describe("SignalProcessor — min whale buy filter", () => {
  it("skips BUY below minWhaleBuyAmountSol", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0.6 } }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(buildRawBuy({ amount: 0.5, signature: "s-low" }));

    expect(signals).toHaveLength(0);
  });

  it("accepts BUY at or above threshold", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0.6 } }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(buildRawBuy({ amount: 0.6, signature: "s-eq" }));
    proc.handleWhaleTx(
      buildRawBuy({ amount: 1, signature: "s-hi", tokenOut: TOKEN_Y }),
    );

    expect(signals).toHaveLength(2);
    expect(signals[0]!.token).toBe("TokenX");
    expect(signals[1]!.token).toBe(TOKEN_Y);
  });
});

describe("SignalProcessor — position lock (one owner per token cycle)", () => {
  it("blocks BUY from a different whale when token already owned", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "a1" }),
    );
    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_B, tokenOut: TOKEN_X, signature: "b1" }),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]!.whaleWallet).toBe(WHALE_A);
  });

  it("tracks position owner for later isSellFromPositionOwner checks", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    collect(proc);

    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "a1" }),
    );

    expect(proc.hasTrackedBuyCycle(TOKEN_X)).toBe(true);
    expect(proc.isSellFromPositionOwner(TOKEN_X, WHALE_A)).toBe(true);
    expect(proc.isSellFromPositionOwner(TOKEN_X, WHALE_B)).toBe(false);
  });
});

describe("SignalProcessor — rebuy ladder & limits", () => {
  it("allows up to rebuyMaxCount BUYs from the same whale", () => {
    const proc = new SignalProcessor(
      buildAppConfig({
        trading: {
          minWhaleBuyAmountSol: 0,
          rebuyEnabled: true,
          rebuyMaxCount: 3,
          rebuyAmountSize: 0,
          fixedBuyAmountSol: 0.1,
        },
      }),
    );
    const signals = collect(proc);

    for (let i = 0; i < 5; i++) {
      proc.handleWhaleTx(
        buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "a" + i }),
      );
    }

    expect(signals).toHaveLength(3);
    expect(proc.getBuyCount(TOKEN_X)).toBe(3);
  });

  it("applies additive ladder: legSizeSol = base + (N-1) * step", () => {
    const proc = new SignalProcessor(
      buildAppConfig({
        trading: {
          minWhaleBuyAmountSol: 0,
          rebuyEnabled: true,
          rebuyMaxCount: 4,
          rebuyAmountSize: 0.05,
          fixedBuyAmountSol: 0.1,
        },
      }),
    );
    const signals = collect(proc);

    for (let i = 0; i < 3; i++) {
      proc.handleWhaleTx(
        buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "s" + i }),
      );
    }

    const sizes = signals.map((s) => s.legSizeSol);
    expect(sizes).toHaveLength(3);
    expect(sizes[0]).toBeCloseTo(0.1, 6);
    expect(sizes[1]).toBeCloseTo(0.15, 6);
    expect(sizes[2]).toBeCloseTo(0.2, 6);
  });

  it("treats rebuyEnabled=false as max 1 BUY per cycle", () => {
    const proc = new SignalProcessor(
      buildAppConfig({
        trading: {
          minWhaleBuyAmountSol: 0,
          rebuyEnabled: false,
          rebuyMaxCount: 5,
          rebuyAmountSize: 0,
        },
      }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "r1" }),
    );
    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "r2" }),
    );

    expect(signals).toHaveLength(1);
  });
});

describe("SignalProcessor — SELL gating", () => {
  it("drops SELL if no tracked BUY cycle exists for the token", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(
      buildRawSell({ wallet: WHALE_A, tokenIn: TOKEN_X, signature: "sell" }),
    );

    expect(signals).toHaveLength(0);
  });

  it("drops SELL from a whale that isn't the position owner", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "a-buy" }),
    );
    proc.handleWhaleTx(
      buildRawSell({ wallet: WHALE_B, tokenIn: TOKEN_X, signature: "b-sell" }),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]!.action).toBe("BUY");
    expect(proc.hasTrackedBuyCycle(TOKEN_X)).toBe(true);
  });

  it("closes the cycle and releases lock after owner's SELL", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_A, tokenOut: TOKEN_X, signature: "buy" }),
    );
    proc.handleWhaleTx(
      buildRawSell({ wallet: WHALE_A, tokenIn: TOKEN_X, signature: "sell" }),
    );
    proc.handleWhaleTx(
      buildRawBuy({ wallet: WHALE_B, tokenOut: TOKEN_X, signature: "buy-b" }),
    );

    expect(signals.map((s) => s.action + ":" + s.whaleWallet)).toEqual([
      "BUY:" + WHALE_A,
      "SELL:" + WHALE_A,
      "BUY:" + WHALE_B,
    ]);
    expect(proc.isSellFromPositionOwner(TOKEN_X, WHALE_B)).toBe(true);
  });
});

describe("SignalProcessor — dedup by whale tx signature", () => {
  it("skips duplicate signatures within dedup window", () => {
    const proc = new SignalProcessor(
      buildAppConfig({
        trading: { minWhaleBuyAmountSol: 0 },
        runtime: { dedupWhaleTxMs: 5000, maxConcurrentSwaps: 3 },
      }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(buildRawBuy({ signature: "dupe" }));
    proc.handleWhaleTx(buildRawBuy({ signature: "dupe" }));

    expect(signals).toHaveLength(1);
  });

  it("allows the same signature when dedup is disabled (0)", () => {
    const proc = new SignalProcessor(
      buildAppConfig({
        trading: { minWhaleBuyAmountSol: 0 },
        runtime: { dedupWhaleTxMs: 0, maxConcurrentSwaps: 3 },
      }),
    );
    const signals = collect(proc);

    proc.handleWhaleTx(buildRawBuy({ signature: "s1", tokenOut: TOKEN_X }));
    // Different BUY cycle for a different token so position-lock doesn't
    // mask the dedup behaviour under test.
    proc.handleWhaleTx(buildRawBuy({ signature: "s1", tokenOut: TOKEN_Y }));

    expect(signals).toHaveLength(2);
  });
});

describe("SignalProcessor — pause gate", () => {
  it("suppresses all downstream signals when trading is paused", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    const signals = collect(proc);

    runtimeState.tradingPaused = true;
    proc.handleWhaleTx(buildRawBuy({ signature: "pause-1" }));
    runtimeState.tradingPaused = false;
    proc.handleWhaleTx(buildRawBuy({ signature: "pause-2" }));

    expect(signals).toHaveLength(1);
    expect(signals[0]!.whaleTxSignature).toBe("pause-2");
  });
});

describe("SignalProcessor — persistence hooks", () => {
  it("fires onPositionChange when a new BUY opens a cycle", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    collect(proc);
    const onChange = vi.fn();
    proc.onPositionChange(onChange);

    proc.handleWhaleTx(buildRawBuy({ signature: "b" }));
    proc.handleWhaleTx(buildRawSell({ signature: "s" }));

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("loadPersistedPositions restores cycle ownership", () => {
    const proc = new SignalProcessor(
      buildAppConfig({ trading: { minWhaleBuyAmountSol: 0 } }),
    );
    collect(proc);

    proc.loadPersistedPositions([
      { token: TOKEN_X, owner: WHALE_A, buyCount: 2, openedAtMs: 1 },
    ]);

    expect(proc.hasTrackedBuyCycle(TOKEN_X)).toBe(true);
    expect(proc.getBuyCount(TOKEN_X)).toBe(2);
    expect(proc.isSellFromPositionOwner(TOKEN_X, WHALE_A)).toBe(true);
  });
});
