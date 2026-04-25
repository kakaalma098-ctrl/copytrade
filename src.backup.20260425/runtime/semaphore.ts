/** Antrian swap on-chain — batasi paralelisme ke RPC/Jupiter. */
export class AsyncSemaphore {
  private current = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    while (this.current >= this.max) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.current++;
  }

  release(): void {
    this.current--;
    const wake = this.waiters.shift();
    if (wake) {
      wake();
    }
  }
}
