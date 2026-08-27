// Owned structured logger: JSON lines, one event per line. Hard rule 9 is
// enforced here, not by reviewer vigilance — field names that look like
// secrets or PII are redacted at write time, whatever the call site passes.
export type LogFields = Record<string, unknown>;

const SENSITIVE_KEY = /token|password|secret|authorization|api[_-]?key|email|card|ssn/i;

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[redacted]";
    } else if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      out[key] = sanitize(value as LogFields);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type LogLevel = "info" | "warn" | "error";

export class Logger {
  constructor(
    private readonly base: LogFields = {},
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + "\n")
  ) {}

  child(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields }, this.write);
  }

  info(msg: string, fields: LogFields = {}): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    this.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg, ...sanitize({ ...this.base, ...fields }) })
    );
  }
}

/** No-op logger for tests that don't assert on logging. */
export const silentLogger = new Logger({}, () => {});
