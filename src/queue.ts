/**
 * Concurrency-1 job queue. One browser, one tab: a second tool call waits its turn
 * instead of racing the first one's chat window.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  constructor(private readonly pacingMs = 0) {}

  get depth(): number {
    return this.#depth;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.#depth++;
    const result = this.#tail.then(job, job);
    // Keep the chain alive regardless of outcome, and pace successive jobs.
    this.#tail = result.then(
      () => sleep(this.pacingMs),
      () => sleep(this.pacingMs),
    );
    return result.finally(() => {
      this.#depth--;
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
