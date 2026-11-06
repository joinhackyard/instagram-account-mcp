// All logs go to stderr: in stdio mode stdout carries the MCP protocol.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

// Meta user/page tokens (EAA...), Instagram tokens (IG...), confirmation tokens, bearer headers,
// access_token / client_secret / signature query params, and S3/Azure signatures.
const SECRET =
  /(EAA[A-Za-z0-9]{20,}|IG[A-Za-z0-9_-]{30,}|cf_[\w-]{10,}|(?:Bearer|OAuth)\s+[\w.-]+|(?:access_token|client_secret|fb_exchange_token|code|X-Amz-Signature|X-Amz-Credential|sig)=[^&\s"]+)/g;

export function redact(s: string): string {
  return s.replace(SECRET, "[redacted]");
}

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(redact(JSON.stringify(line)) + "\n");
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => write("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => write("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => write("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => write("error", m, e),
};
