export interface Clock {
  now(): number;
  arm(at: number, run: () => void): () => void;
}

export const systemClock: Clock = {
  now: Date.now,

  arm(at, run) {
    const timer = setTimeout(run, Math.max(0, Math.min(at - Date.now(), 2_147_483_647)));
    return () => {
      clearTimeout(timer);
    };
  },
};

export class ManualClock implements Clock {
  private readonly timers = new Map<symbol, { at: number; run: () => void }>();
  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  arm(at: number, run: () => void): () => void {
    const key = Symbol("timer");
    this.timers.set(key, { at, run });
    return () => {
      this.timers.delete(key);
    };
  }

  advance(to: number): void {
    if (to < this.time) throw new Error("Clock cannot go backwards");
    this.time = to;
    const due = [...this.timers].filter(([, timer]) => timer.at <= to);
    for (const [key, timer] of due) {
      this.timers.delete(key);
      timer.run();
    }
  }
}
