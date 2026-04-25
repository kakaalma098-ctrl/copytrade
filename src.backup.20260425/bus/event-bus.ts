import { EventEmitter } from "node:events";
import type {
  ExecutionResult,
  RawWhaleTransaction,
  TradeSignal,
} from "../types/index.js";

export type BusEvents = {
  "whale:tx": [tx: RawWhaleTransaction];
  "signal:trade": [signal: TradeSignal];
  "exec:result": [result: ExecutionResult];
};

class TypedEventBus extends EventEmitter {
  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * N12: deferred emit — listeners run on the next event-loop tick via
   * setImmediate, so heavy listeners (Telegram notifier, latency formatting)
   * do not block the caller's wall time on the hot path. Use for fire-and-
   * forget notifications where the caller does not depend on listener
   * completion. Sync `emit` is still available for ordered fan-out.
   */
  emitAsync<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    setImmediate(() => {
      super.emit(event, ...args);
    });
  }

  on<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

export const bus = new TypedEventBus();
