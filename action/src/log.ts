// Logging seam. `error` is the one a human should look at: in the action it
// becomes a GitHub `::error::` annotation on the run summary. The action still
// exits 0 after one, because a declined promotion is a safe outcome and a
// published build must never be marked failed over this bookkeeping.

export interface Logger {
  info(message: string): void;
  notice(message: string): void;
  error(message: string): void;
}

/** A logger that records everything, for tests. */
export class MemoryLogger implements Logger {
  readonly infos: string[] = [];
  readonly notices: string[] = [];
  readonly errors: string[] = [];
  info(message: string): void {
    this.infos.push(message);
  }
  notice(message: string): void {
    this.notices.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}
