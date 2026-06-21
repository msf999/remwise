/** Verbose, copyable diagnostic log for one sync run.
 *
 * A `SyncLog` accumulates timestamped lines as the plugin talks to Readwise, computes the plan, and
 * applies it. The popup exposes its text through the "copy log" button so a whole run can be pasted
 * elsewhere for debugging. The lib functions take an optional `SyncLog` and write to it via `log?.…`,
 * so logging is entirely opt-in and side-effect-free when no log is passed.
 */
export class SyncLog {
  private readonly started = Date.now();
  private readonly lines: string[] = [];

  constructor() {
    this.lines.push('=== Remwise sync log ===');
    this.lines.push(`Generated: ${new Date(this.started).toISOString()}`);
  }

  /** Append one line, tagged with a [scope] and a +ms-since-start stamp. */
  log(scope: string, message: string): void {
    const dt = Date.now() - this.started;
    this.lines.push(`[+${String(dt).padStart(6)}ms] [${scope}] ${message}`);
  }

  /** Start a visually separated section. */
  section(title: string): void {
    this.lines.push('');
    this.lines.push(`--- ${title} ---`);
  }

  /** The full accumulated log as text. */
  toText(): string {
    return this.lines.join('\n');
  }
}
