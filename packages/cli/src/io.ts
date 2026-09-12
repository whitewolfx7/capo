/**
 * The CLI's output seam. Every command writes through this instead of
 * `console.log`/`console.error` so tests can capture output by calling
 * `main()` directly, without spawning a process.
 */
export interface Io {
  out(s: string): void;
  err(s: string): void;
}
