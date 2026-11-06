import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP, PACKAGE } from "./config.js";

/** Namespaced so it never clobbers another "instagram" MCP server the user already has. */
export const SERVER_NAME = "instagram-account";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * How MCP clients should start the server. Running from an npx cache → pin `npx -y instagram-account-mcp`;
 * running from a global install or a git checkout → `node /abs/path/cli.js` (fast, works offline).
 * GUI apps often start with a minimal PATH, so node's folder is put on PATH explicitly.
 */
export function launchSpec(mode: "auto" | "npx" | "node" = "auto"): LaunchSpec {
  const script = fileURLToPath(new URL("./cli.js", import.meta.url));
  const nodeBin = dirname(process.execPath);
  const isWin = process.platform === "win32";
  const extra = isWin ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const env = {
    PATH: [nodeBin, ...extra].filter((p, i, a) => a.indexOf(p) === i).join(delimiter),
  };
  const viaNpx = mode === "npx" || (mode === "auto" && /[\\/]_npx[\\/]/.test(script));
  if (viaNpx) {
    const npx = join(nodeBin, isWin ? "npx.cmd" : "npx");
    return {
      command: existsSync(npx) ? npx : "npx",
      args: ["-y", `${PACKAGE}@latest`],
      env,
    };
  }
  return { command: process.execPath, args: [script], env };
}

export interface ClientTarget {
  id: string;
  name: string;
  detect(): boolean;
  install(spec: LaunchSpec): string;
  remove(): string;
}

const home = homedir();

/** Keep the user's original config once: later installs never overwrite this backup. */
function backup(file: string) {
  const bak = `${file}.before-${APP}.bak`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
}

/** Write via a temp file + rename so a crash never leaves a half-written config. */
function writeAtomic(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new Error(`${file} is not a valid JSON object; fix or remove it first.`);
}

function jsonClient(
  id: string,
  name: string,
  file: string,
  detectDir: string,
  extra: Record<string, unknown> = {},
): ClientTarget {
  return {
    id,
    name,
    detect: () => existsSync(detectDir),
    install(spec) {
      const cfg = readJson(file);
      const servers = (cfg.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers[SERVER_NAME] = {
        command: spec.command,
        args: spec.args,
        env: spec.env,
        ...extra,
      };
      cfg.mcpServers = servers;
      mkdirSync(dirname(file), { recursive: true });
      backup(file);
      writeAtomic(file, JSON.stringify(cfg, null, 2) + "\n");
      return `${name}: added "${SERVER_NAME}" to ${file}. Restart ${name}.`;
    },
    remove() {
      const cfg = readJson(file);
      const servers = cfg.mcpServers as Record<string, unknown> | undefined;
      if (!servers?.[SERVER_NAME]) return `${name}: not installed.`;
      delete servers[SERVER_NAME];
      backup(file);
      writeAtomic(file, JSON.stringify(cfg, null, 2) + "\n");
      return `${name}: removed from ${file}.`;
    },
  };
}

function claudeDesktopFile(): string {
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32")
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  return join(
    process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    "Claude",
    "claude_desktop_config.json",
  );
}

function which(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    stdio: "ignore",
  });
  return r.status === 0;
}

const claudeCode: ClientTarget = {
  id: "claude-code",
  name: "Claude Code",
  detect: () => which("claude"),
  install(spec) {
    const envArgs = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    spawnSync("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"], {
      stdio: "ignore",
    });
    const r = spawnSync(
      "claude",
      ["mcp", "add", SERVER_NAME, "--scope", "user", ...envArgs, "--", spec.command, ...spec.args],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim()}`);
    return "Claude Code: added for all projects (user scope). Run /mcp in Claude Code to check.";
  },
  remove() {
    const r = spawnSync("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"], {
      encoding: "utf8",
    });
    return r.status === 0 ? "Claude Code: removed." : "Claude Code: not installed.";
  },
};

/** Replace or append a `[mcp_servers.instagram-account]` table in Codex's config.toml. */
export function upsertCodexToml(toml: string, spec: LaunchSpec | null): string {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  // Matches [mcp_servers.instagram-account], quoted keys, extra spaces, trailing comments, and its sub-tables.
  const ownHeader = new RegExp(
    `^\\[\\s*mcp_servers\\.(["']?)${SERVER_NAME}\\1(\\.[\\w"'.-]+)?\\s*\\](\\s*#.*)?$`,
  );
  const lines = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (ownHeader.test(t)) {
      skipping = true;
      continue;
    }
    if (skipping && t.startsWith("[")) skipping = false;
    if (!skipping) out.push(line);
  }
  let body = out.join("\n").replace(/\n+$/, "");
  if (spec) {
    const q = (s: string) => JSON.stringify(s);
    body += `${body ? "\n\n" : ""}${header}\ncommand = ${q(spec.command)}\nargs = [${spec.args.map(q).join(", ")}]\ntool_timeout_sec = 180\n\n[mcp_servers.${SERVER_NAME}.env]\n${Object.entries(
      spec.env,
    )
      .map(([k, v]) => `${k} = ${q(v)}`)
      .join("\n")}`;
  }
  return body + "\n";
}

const codexFile = join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
const codex: ClientTarget = {
  id: "codex",
  name: "Codex",
  detect: () => existsSync(dirname(codexFile)),
  install(spec) {
    const cur = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : "";
    mkdirSync(dirname(codexFile), { recursive: true });
    backup(codexFile);
    writeAtomic(codexFile, upsertCodexToml(cur, spec));
    return `Codex: added [mcp_servers.${SERVER_NAME}] to ${codexFile}.`;
  },
  remove() {
    if (!existsSync(codexFile)) return "Codex: not installed.";
    backup(codexFile);
    writeFileSync(codexFile, upsertCodexToml(readFileSync(codexFile, "utf8"), null));
    return "Codex: removed.";
  },
};

/**
 * Insert or replace `instagram-account:` under the top-level `mcp_servers:` key of Hermes' config.yaml,
 * keeping every other line untouched (no YAML round-trip, so comments and formatting survive).
 */
export function upsertHermesYaml(yaml: string, spec: LaunchSpec | null): string {
  const lines = yaml.replace(/\r/g, "").split("\n");
  let top = lines.findIndex((l) => /^mcp_servers:\s*(\{\s*\}|~|null)?\s*(#.*)?$/.test(l));
  if (top >= 0) lines[top] = "mcp_servers:";
  const indentOf = (l: string) => l.length - l.trimStart().length;

  // Find the section end and its child indentation.
  let end = lines.length;
  let childIndent = 2;
  if (top >= 0) {
    for (let i = top + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() && !l.trimStart().startsWith("#") && indentOf(l) === 0) {
        end = i;
        break;
      }
    }
    const firstChild = lines
      .slice(top + 1, end)
      .find((l) => l.trim() && !l.trimStart().startsWith("#"));
    if (firstChild) childIndent = indentOf(firstChild);
    // Remove an existing instagram-account block.
    const start = lines.findIndex(
      (l, i) =>
        i > top &&
        i < end &&
        indentOf(l) === childIndent &&
        (l.trim() === `${SERVER_NAME}:` ||
          l.trim().startsWith(`${SERVER_NAME}: `) ||
          l.trim().startsWith(`"${SERVER_NAME}":`)),
    );
    if (start >= 0) {
      let stop = start + 1;
      while (stop < end && (!lines[stop].trim() || indentOf(lines[stop]) > childIndent)) stop++;
      lines.splice(start, stop - start);
      end -= stop - start;
    }
  }
  if (spec) {
    const p = " ".repeat(childIndent);
    const q = (s: string) => JSON.stringify(s);
    const block = [
      `${p}${SERVER_NAME}:`,
      `${p}  command: ${q(spec.command)}`,
      `${p}  args: [${spec.args.map(q).join(", ")}]`,
      `${p}  env:`,
      ...Object.entries(spec.env).map(([k, v]) => `${p}    ${k}: ${q(v)}`),
      `${p}  timeout: 180`,
      `${p}  connect_timeout: 90`,
      `${p}  enabled: true`,
    ];
    if (top >= 0) {
      lines.splice(top + 1, 0, ...block);
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push("", "mcp_servers:", ...block);
    }
  } else if (top >= 0) {
    const rest = lines.slice(top + 1).findIndex((l) => l.trim() && !l.trimStart().startsWith("#"));
    const next = rest >= 0 ? lines[top + 1 + rest] : undefined;
    if (!next || indentOf(next) === 0) lines[top] = "mcp_servers: {}";
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

const hermesFile = join(process.env.HERMES_HOME ?? join(home, ".hermes"), "config.yaml");
const hermes: ClientTarget = {
  id: "hermes",
  name: "Hermes Agent",
  detect: () => existsSync(hermesFile) || which("hermes"),
  install(spec) {
    const cur = existsSync(hermesFile) ? readFileSync(hermesFile, "utf8") : "";
    mkdirSync(dirname(hermesFile), { recursive: true });
    backup(hermesFile);
    writeAtomic(hermesFile, upsertHermesYaml(cur, spec));
    return `Hermes Agent: added mcp_servers.${SERVER_NAME} to ${hermesFile}. Restart Hermes; tools appear as mcp_${SERVER_NAME.replace(/-/g, "_")}_*.`;
  },
  remove() {
    if (!existsSync(hermesFile)) return "Hermes Agent: not installed.";
    backup(hermesFile);
    writeFileSync(hermesFile, upsertHermesYaml(readFileSync(hermesFile, "utf8"), null));
    return "Hermes Agent: removed.";
  },
};

const desktopFile = claudeDesktopFile();

export const CLIENTS: ClientTarget[] = [
  jsonClient("claude-desktop", "Claude Desktop", desktopFile, dirname(desktopFile)),
  claudeCode,
  jsonClient("cursor", "Cursor", join(home, ".cursor", "mcp.json"), join(home, ".cursor")),
  jsonClient(
    "windsurf",
    "Windsurf",
    join(home, ".codeium", "windsurf", "mcp_config.json"),
    join(home, ".codeium", "windsurf"),
  ),
  codex,
  hermes,
];

export function manualSnippets(spec: LaunchSpec): string {
  const json = JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: spec.command,
          args: spec.args,
          env: spec.env,
        },
      },
    },
    null,
    2,
  );
  return `Any MCP client (JSON config, e.g. Claude Desktop / Cursor / Windsurf / VS Code):\n${json}\n\nHermes (~/.hermes/config.yaml):\n${upsertHermesYaml("", spec).trim()}\n\nCodex (~/.codex/config.toml):\n${upsertCodexToml("", spec).trim()}`;
}
