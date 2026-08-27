import { describe, expect, it } from "vitest";
import { Logger } from "./logger.js";

function capture() {
  const lines: any[] = [];
  const logger = new Logger({}, (line) => lines.push(JSON.parse(line)));
  return { lines, logger };
}

describe("structured logger", () => {
  it("emits JSON lines with level, message, and merged child fields", () => {
    const { lines, logger } = capture();
    logger.child({ module: "api" }).info("http", { status: 200, ms: 12 });
    expect(lines[0]).toMatchObject({ level: "info", msg: "http", module: "api", status: 200, ms: 12 });
    expect(typeof lines[0].ts).toBe("string");
  });

  it("hard rule 9: secret- and PII-looking fields are redacted at write time, nested included", () => {
    const { lines, logger } = capture();
    logger.error("oops", {
      token: "abc123",
      password: "hunter2",
      apiKey: "sk-live",
      email: "sam@example.com",
      cardNumber: "4242",
      context: { authorization: "Bearer xyz", requestId: "r-1" },
      safe: "value",
    });
    expect(lines[0]).toMatchObject({
      token: "[redacted]",
      password: "[redacted]",
      apiKey: "[redacted]",
      email: "[redacted]",
      cardNumber: "[redacted]",
      context: { authorization: "[redacted]", requestId: "r-1" },
      safe: "value",
    });
  });
});
