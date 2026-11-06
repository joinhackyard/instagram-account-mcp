import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchSpec } from "./clients.js";
import { APP, VERSION } from "./config.js";

/**
 * Keeps `daemon` running in the background (scheduled posts publish, A/B tests finish, sign-ins stay fresh) even when no AI app is open.
 * macOS: a LaunchAgent. Linux: a systemd user service. Windows: a Task Scheduler entry at log-on.
 */
const LABEL = "org.hackyard.instagram-account-mcp";

function paths() {
  return {
    plist: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    unit: join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "systemd",
      "user",
      `${APP}.service`,
    ),
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function installService(): string {
  const spec = launchSpec("auto");
  // Pin the version: a background process with keychain access must not update itself silently.
  const args = spec.args.map((a) => a.replace(/@latest$/, `@${VERSION}`));
  const argv = [spec.command, ...args, "daemon"];
  // Use the same data folder and token storage as the AI apps.
  const env: Record<string, string> = { ...spec.env };
  for (const k of ["IG_MCP_HOME", "IG_MCP_VAULT"]) if (process.env[k]) env[k] = process.env[k]!;
  if (process.platform === "darwin") {
    const { plist } = paths();
    const logs = join(homedir(), "Library", "Logs", APP);
    mkdirSync(logs, { recursive: true });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "daemon.log"))}</string>
</dict></plist>
`,
    );
    const uid = process.getuid?.() ?? 501;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    let r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    if (r.status !== 0) {
      // bootout finishes asynchronously; give it a moment and try once more.
      spawnSync("sleep", ["2"]);
      r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    }
    if (r.status !== 0)
      throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
    return `Installed a LaunchAgent (${plist}). It starts at log-in and restarts if it stops. Logs: ${join(logs, "daemon.log")}`;
  }
  if (process.platform === "linux") {
    const { unit } = paths();
    mkdirSync(dirname(unit), { recursive: true });
    // systemd: quote arguments with spaces, escape $ and % (specifier and variable expansion).
    const esc = (a: string) => a.replace(/%/g, "%%").replace(/\$/g, "$$$$");
    const q = (a: string) => (/[\s"\\]/.test(a) ? JSON.stringify(esc(a)) : esc(a));
    writeFileSync(
      unit,
      `[Unit]
Description=Instagram Account MCP background service (scheduled posts, A/B tests)
After=network-online.target

[Service]
ExecStart=${argv.map(q).join(" ")}
${Object.entries(env)
  .map(([k, v]) => `Environment=${JSON.stringify(`${k}=${esc(v)}`)}`)
  .join("\n")}
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
`,
    );
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", `${APP}.service`], {
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`systemctl failed: ${(r.stderr || r.stdout).trim()}`);
    return `Installed a systemd user service (${unit}). Logs: journalctl --user -u ${APP}. On servers also run: loginctl enable-linger $USER`;
  }
  if (process.platform === "win32") {
    const cmd = argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
    const r = spawnSync(
      "schtasks",
      ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", APP, "/TR", cmd],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`schtasks failed: ${(r.stderr || r.stdout).trim()}`);
    spawnSync("schtasks", ["/Run", "/TN", APP], { stdio: "ignore" });
    return `Installed a scheduled task "${APP}" that starts at log-on.`;
  }
  throw new Error(
    `Background service is not supported on ${process.platform}; run \`${APP} daemon\` yourself.`,
  );
}

export function uninstallService(): string {
  if (process.platform === "darwin") {
    const { plist } = paths();
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], {
      stdio: "ignore",
    });
    rmSync(plist, { force: true });
    return "Background service removed.";
  }
  if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", `${APP}.service`], { stdio: "ignore" });
    rmSync(paths().unit, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    return "Background service removed.";
  }
  if (process.platform === "win32") {
    spawnSync("schtasks", ["/Delete", "/F", "/TN", APP], { stdio: "ignore" });
    return "Scheduled task removed.";
  }
  return "Nothing to remove.";
}

export function serviceStatus(): string {
  if (process.platform === "darwin") {
    if (!existsSync(paths().plist)) return "not installed";
    const r = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`], {
      encoding: "utf8",
    });
    return r.status === 0
      ? /state = running/.test(r.stdout)
        ? "running"
        : "installed (not running)"
      : "installed (not loaded)";
  }
  if (process.platform === "linux") {
    if (!existsSync(paths().unit)) return "not installed";
    const r = spawnSync("systemctl", ["--user", "is-active", `${APP}.service`], {
      encoding: "utf8",
    });
    return r.stdout.trim() || "unknown";
  }
  if (process.platform === "win32") {
    const r = spawnSync("schtasks", ["/Query", "/TN", APP], { encoding: "utf8" });
    return r.status === 0 ? "installed" : "not installed";
  }
  return "unsupported";
}
