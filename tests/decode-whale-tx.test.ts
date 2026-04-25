import { describe, expect, it, vi } from "vitest";
import { decodeWhaleSwap } from "../src/listener/decode-whale-tx.js";
import {
  NATIVE_SOL,
  PROGRAMS,
  TOKEN_X,
  TOKEN_Y,
  USDC,
  WHALE,
  buildFrame,
  tokenRow,
} from "./fixtures/whale-frames.js";

describe("decodeWhaleSwap — BUY detection (SOL -> token)", () => {
  it("returns BUY with correct amount when whale spends native SOL for SPL token", () => {
    const frame = buildFrame({
      programIds: [PROGRAMS.RAYDIUM],
      preNativeSol: 10,
      postNativeSol: 9,
      preToken: [],
      postToken: [tokenRow(TOKEN_X, WHALE, 1_000_000, 6)],
    });

    const result = decodeWhaleSwap(frame);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("BUY");
    expect(result?.tokenIn).toBe(NATIVE_SOL);
    expect(result?.tokenOut).toBe(TOKEN_X);
    expect(result?.amount).toBeCloseTo(1, 4);
    expect(result?.protocolHint).toBe("RAYDIUM");
    expect(result?.wallet).toBe(WHALE);
  });

  it("treats WSOL spend the same as native SOL spend", () => {
    const frame = buildFrame({
      programIds: [PROGRAMS.METEORA],
      preNativeSol: 10,
      postNativeSol: 10,
      preToken: [tokenRow(NATIVE_SOL, WHALE, 2, 9)],
      postToken: [
        tokenRow(NATIVE_SOL, WHALE, 1, 9),
        tokenRow(TOKEN_X, WHALE, 500_000, 6),
      ],
    });

    const result = decodeWhaleSwap(frame);

    expect(result?.type).toBe("BUY");
    expect(result?.amount).toBeCloseTo(1, 4);
    expect(result?.protocolHint).toBe("METEORA");
  });
});

describe("decodeWhaleSwap — SELL detection (token -> SOL)", () => {
  it("returns SELL when whale receives native SOL and loses SPL token", () => {
    const frame = buildFrame({
      programIds: [PROGRAMS.RAYDIUM],
      preNativeSol: 10,
      postNativeSol: 11,
      preToken: [tokenRow(TOKEN_X, WHALE, 1_000_000, 6)],
      postToken: [],
    });

    const result = decodeWhaleSwap(frame);

    expect(result?.type).toBe("SELL");
    expect(result?.tokenIn).toBe(TOKEN_X);
    expect(result?.tokenOut).toBe(NATIVE_SOL);
    expect(result?.amount).toBeCloseTo(1, 4);
    expect(result?.whaleSellFraction).toBeCloseTo(1, 4);
  });

  it("computes whaleSellFraction when whale sells part of their position", () => {
    const frame = buildFrame({
      programIds: [PROGRAMS.RAYDIUM],
      preNativeSol: 10,
      postNativeSol: 10.5,
      preToken: [tokenRow(TOKEN_X, WHALE, 1_000_000, 6)],
      postToken: [tokenRow(TOKEN_X, WHALE, 750_000, 6)],
    });

    const result = decodeWhaleSwap(frame);

    expect(result?.type).toBe("SELL");
    expect(result?.whaleSellFraction).toBeCloseTo(0.25, 3);
  });
});

describe("decodeWhaleSwap — drop reasons", () => {
  it("drops when whale not in accountKeys", () => {
    const onDrop = vi.fn();
    const frame = buildFrame({
      whale: WHALE,
      preNativeSol: 10,
      postNativeSol: 9,
    });
    frame.accountKeys = frame.accountKeys.filter((k) => k !== WHALE);

    const result = decodeWhaleSwap(frame, onDrop);

    expect(result).toBeNull();
    expect(onDrop).toHaveBeenCalledWith("whale_not_in_account_keys");
  });

  it("drops when there is no primary token delta", () => {
    const onDrop = vi.fn();
    const frame = buildFrame({
      preNativeSol: 10,
      postNativeSol: 9.5,
    });

    const result = decodeWhaleSwap(frame, onDrop);

    expect(result).toBeNull();
    expect(onDrop).toHaveBeenCalledWith("no_primary_token_mint_delta");
  });

  it("drops stable-only swaps (USDC as primary mint)", () => {
    const onDrop = vi.fn();
    const frame = buildFrame({
      preNativeSol: 10,
      postNativeSol: 9,
      postToken: [tokenRow(USDC, WHALE, 1_000_000, 6)],
    });

    const result = decodeWhaleSwap(frame, onDrop);

    expect(result).toBeNull();
    expect(onDrop).toHaveBeenCalledWith("stable_or_quote_mint_only");
  });

  it("drops BUY when SOL net delta is not negative enough (wrong direction)", () => {
    const onDrop = vi.fn();
    const frame = buildFrame({
      preNativeSol: 10,
      postNativeSol: 10,
      postToken: [tokenRow(TOKEN_X, WHALE, 1_000_000, 6)],
    });

    const result = decodeWhaleSwap(frame, onDrop);

    expect(result).toBeNull();
    expect(onDrop).toHaveBeenCalledWith(
      "buy_expected_sol_spent_but_sol_net_not_negative",
    );
  });

  it("drops SELL when SOL net delta is not positive enough", () => {
    const onDrop = vi.fn();
    const frame = buildFrame({
      preNativeSol: 10,
      postNativeSol: 10,
      preToken: [tokenRow(TOKEN_X, WHALE, 1_000_000, 6)],
      postToken: [],
    });

    const result = decodeWhaleSwap(frame, onDrop);

    expect(result).toBeNull();
    expect(onDrop).toHaveBeenCalledWith(
      "sell_expected_sol_received_but_sol_net_not_positive",
    );
  });

  it("drops complex multi-leg SPL swaps by default", () => {
    const onDrop = vi.fn();
    const frame = buildFrame({
      programIds: [PROGRAMS.RAYDIUM],
      preNativeSol: 10,
      postNativeSol: 9,
      preToken: [tokenRow(TOKEN_Y, WHALE, 1_000_000, 6)],
      postToken: [
        tokenRow(TOKEN_X, WHALE, 1_000_000, 6),
        tokenRow(TOKEN_Y, WHALE, 200_000, 6),
      ],
    });

    const result = decodeWhaleSwap(frame, onDrop);

    expect(result).toBeNull();
    expect(onDrop).toHaveBeenCalledWith("multi_leg_spl_not_simple_swap");
  });

  it("allows multi-leg follow when allowMultiLegNetFollow=true", () => {
    const frame = buildFrame({
      programIds: [PROGRAMS.RAYDIUM],
      preNativeSol: 10,
      postNativeSol: 9,
      preToken: [tokenRow(TOKEN_Y, WHALE, 1_000_000, 6)],
      postToken: [
        tokenRow(TOKEN_X, WHALE, 1_000_000, 6),
        tokenRow(TOKEN_Y, WHALE, 200_000, 6),
      ],
    });

    const result = decodeWhaleSwap(frame, undefined, {
      allowMultiLegNetFollow: true,
      maxOtherSplLegRatio: 0.25,
    });

    expect(result?.type).toBe("BUY");
    expect(result?.tokenOut).toBe(TOKEN_X);
  });
});

describe("detectProtocolHint — priority ordering", () => {
  const mkBuy = (programIds: string[], logs: string[] = []) =>
    buildFrame({
      programIds,
      logs,
      preNativeSol: 10,
      postNativeSol: 9,
      postToken: [tokenRow(TOKEN_X, WHALE, 1_000_000, 6)],
    });

  it("detects PUMPFUN when bonding-curve program present", () => {
    const result = decodeWhaleSwap(mkBuy([PROGRAMS.PUMPFUN, PROGRAMS.RAYDIUM]));
    expect(result?.protocolHint).toBe("PUMPFUN");
  });

  it("prefers PUMPSWAP over RAYDIUM when both present", () => {
    const result = decodeWhaleSwap(
      mkBuy([PROGRAMS.PUMPSWAP, PROGRAMS.RAYDIUM]),
    );
    expect(result?.protocolHint).toBe("PUMPSWAP");
  });

  it("prefers METEORA over RAYDIUM when both present", () => {
    const result = decodeWhaleSwap(mkBuy([PROGRAMS.METEORA, PROGRAMS.RAYDIUM]));
    expect(result?.protocolHint).toBe("METEORA");
  });

  it("falls back to UNKNOWN when no known programs and no log signals", () => {
    const result = decodeWhaleSwap(mkBuy([]));
    expect(result?.protocolHint).toBe("UNKNOWN");
  });

  it("uses log heuristic when program IDs missing (PUMPSWAP)", () => {
    const result = decodeWhaleSwap(
      mkBuy([], ["Program log: Pump Swap executed"]),
    );
    expect(result?.protocolHint).toBe("PUMPSWAP");
  });
});
