import express, { type Request, type Response } from "express";
import { readFileSync, existsSync, readdirSync, statSync, copyFileSync, unlinkSync, writeFileSync } from "fs";
import { execFile, execFileSync, spawn } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import https from "https";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(__dirname, "..");
const dataDirectory = join(projectDirectory, "data");
const accountsPath = join(projectDirectory, "accounts.conf");
const statePath = join(dataDirectory, "state.json");
const monitorPidPath = join(dataDirectory, "monitor.pid");
const monitorLogPath = join(dataDirectory, "monitor.log");
const rotatePath = join(projectDirectory, "rotation", "rotate");
const monitorPath = join(projectDirectory, "rotation", "monitor");
const statsPath = join(homedir(), ".claude", "stats-cache.json");
const sessionsDirectory = join(homedir(), ".claude", "sessions");
const debugDirectory = join(homedir(), ".claude", "debug");

interface State {
  current: number;
  email?: string;
  timestamp?: string;
}

const app = express();
app.use(express.json());

function readAccounts(): string[] {
  if (!existsSync(accountsPath)) return [];
  return readFileSync(accountsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function readState(): State {
  if (!existsSync(statePath)) return { current: 0 };
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { current: 0 };
  }
}

function isMonitorRunning(): boolean {
  if (!existsSync(monitorPidPath)) return false;
  const pid = readFileSync(monitorPidPath, "utf8").trim();
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function getMonitorPid(): string | null {
  if (!existsSync(monitorPidPath)) return null;
  return readFileSync(monitorPidPath, "utf8").trim();
}

app.get("/api/status", (_: Request, response: Response) => {
  const accounts = readAccounts();
  const state = readState();

  // Use CLI auth as source of truth for active account
  execFile("claude", ["auth", "status"], { timeout: 5000 }, (error, stdout) => {
    let current = state.current;
    let email = accounts[current] || "unknown";

    if (!error && stdout) {
      try {
        const auth = JSON.parse(stdout);
        if (auth.email) {
          const index = accounts.indexOf(auth.email);
          if (index !== -1) {
            current = index;
            email = auth.email;
          } else {
            email = auth.email;
          }
        }
      } catch {}
    }

    response.json({
      accounts,
      current,
      email,
      timestamp: state.timestamp || null,
      monitor: {
        running: isMonitorRunning(),
        pid: getMonitorPid(),
      },
    });
  });
});

app.post("/api/rotate", (request: Request, response: Response) => {
  const target = request.body?.email as string | undefined;
  const arguments_ = target ? [target] : [];

  response.json({ status: "rotating", target: target || "next" });

  execFile(rotatePath, arguments_, { timeout: 180000 }, (error, _stdout, stderr) => {
    if (error) console.error("Rotate error:", stderr);
  });
});

app.post("/api/monitor/start", (_: Request, response: Response) => {
  if (isMonitorRunning()) {
    response.json({ status: "already_running", pid: getMonitorPid() });
    return;
  }
  execFile(monitorPath, ["--daemon"], (error, stdout) => {
    if (error) {
      response.status(500).json({ error: error.message });
    } else {
      response.json({ status: "started", message: stdout.trim() });
    }
  });
});

app.post("/api/monitor/stop", (_: Request, response: Response) => {
  execFile(monitorPath, ["--stop"], (error, stdout) => {
    if (error) {
      response.status(500).json({ error: error.message });
    } else {
      response.json({ status: "stopped", message: stdout.trim() });
    }
  });
});

app.get("/api/logs", (request: Request, response: Response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const source = request.query.source === "rotate" ? join(dataDirectory, "rotate.log") : monitorLogPath;
  if (existsSync(source)) {
    const lines = readFileSync(source, "utf8").split("\n").slice(-100);
    for (const line of lines) {
      if (line.trim()) {
        response.write(
          "data: " + JSON.stringify({ line, source: request.query.source || "monitor" }) + "\n\n"
        );
      }
    }
  }

  const tail = spawn("tail", ["-n", "0", "-f", source], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  tail.stdout.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      response.write(
        "data: " + JSON.stringify({ line, source: request.query.source || "monitor" }) + "\n\n"
      );
    }
  });

  request.on("close", () => tail.kill());
});

app.get("/api/usage", (_: Request, response: Response) => {
  // Active sessions
  let activeSessions = 0;
  try {
    const files = readdirSync(sessionsDirectory).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const session = JSON.parse(readFileSync(join(sessionsDirectory, file), "utf8"));
        process.kill(session.pid, 0);
        activeSessions++;
      } catch {}
    }
  } catch {}

  // Stats from Claude's cache
  let todayMessages = 0;
  let todayTokens = 0;
  let todayTools = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let totalMessages = 0;
  let totalSessions = 0;
  const dailyActivity: Array<{ date: string; messages: number; tokens: number; tools: number }> = [];

  try {
    const stats = JSON.parse(readFileSync(statsPath, "utf8"));
    totalMessages = stats.totalMessages || 0;
    totalSessions = stats.totalSessions || 0;

    // Per-million-token pricing (USD) — from anthropic.com/pricing
    const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
      "claude-opus-4-6":            { input: 5,  output: 25,  cacheRead: 0.50,  cacheWrite: 6.25 },
      "claude-opus-4-5-20251101":   { input: 5,  output: 25,  cacheRead: 0.50,  cacheWrite: 6.25 },
      "claude-sonnet-4-6":          { input: 3,  output: 15,  cacheRead: 0.30,  cacheWrite: 3.75 },
      "claude-sonnet-4-5-20250929": { input: 3,  output: 15,  cacheRead: 0.30,  cacheWrite: 3.75 },
      "claude-haiku-4-5-20251001":  { input: 1,  output: 5,   cacheRead: 0.10,  cacheWrite: 1.25 },
    };
    const fallbackPricing = { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 };

    // Model usage totals + cost calculation
    if (stats.modelUsage) {
      for (const [model, usage] of Object.entries(stats.modelUsage) as Array<[string, Record<string, number>]>) {
        totalTokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
        const rates = pricing[model] || fallbackPricing;
        totalCost += ((usage.inputTokens || 0) / 1_000_000) * rates.input;
        totalCost += ((usage.outputTokens || 0) / 1_000_000) * rates.output;
        totalCost += ((usage.cacheReadInputTokens || 0) / 1_000_000) * rates.cacheRead;
        totalCost += ((usage.cacheCreationInputTokens || 0) / 1_000_000) * rates.cacheWrite;
      }
    }

    // Daily activity (all available)
    const activity = stats.dailyActivity || [];
    const modelTokens = stats.dailyModelTokens || [];
    const tokensByDate: Record<string, number> = {};
    for (const entry of modelTokens) {
      let total = 0;
      for (const count of Object.values(entry.tokensByModel || {}) as number[]) {
        total += count;
      }
      tokensByDate[entry.date] = total;
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const entry of activity) {
      const tokens = tokensByDate[entry.date] || 0;
      dailyActivity.push({ date: entry.date, messages: entry.messageCount, tokens, tools: entry.toolCallCount || 0 });
      if (entry.date === today) {
        todayMessages = entry.messageCount;
        todayTools = entry.toolCallCount;
        todayTokens = tokens;
      }
    }

    // If today has no entry yet, use the most recent day as "latest"
    if (todayMessages === 0 && activity.length > 0) {
      const latest = activity[activity.length - 1];
      todayMessages = latest.messageCount;
      todayTools = latest.toolCallCount || 0;
      todayTokens = tokensByDate[latest.date] || 0;
    }
  } catch {}

  // Today's rate limit signals from debug logs
  let rateLimitCount = 0;
  try {
    const debugFiles = readdirSync(debugDirectory)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => ({ name: f, mtime: statSync(join(debugDirectory, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    for (const file of debugFiles) {
      try {
        const content = readFileSync(join(debugDirectory, file.name), "utf8");
        const today = new Date().toISOString().slice(0, 10);
        for (const line of content.split("\n")) {
          if (!line.startsWith(today)) continue;
          if (/status=429|Rate limited|rate_limit|overloaded|status=529/i.test(line)) {
            if (!line.includes("client_data")) rateLimitCount++;
          }
        }
      } catch {}
    }
  } catch {}

  // Token expiry from stored tokens
  let tokenExpiry: string | null = null;
  try {
    const tokens = JSON.parse(readFileSync(join(dataDirectory, "tokens.json"), "utf8"));
    const authResult = execFileSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 5000 });
    const authData = JSON.parse(authResult);
    const stored = tokens[authData.email];
    if (stored?.expiresAt) {
      tokenExpiry = new Date(stored.expiresAt).toISOString();
    }
  } catch {}

  response.json({
    activeSessions,
    today: {
      messages: todayMessages,
      tokens: todayTokens,
      tools: todayTools,
      rateLimits: rateLimitCount,
    },
    totals: {
      messages: totalMessages,
      tokens: totalTokens,
      sessions: totalSessions,
      cost: Math.round(totalCost * 100) / 100,
    },
    tokenExpiry,
    dailyActivity,
  });
});

// Session cookie reader (Firefox + Chrome)
function getSessionKey(): string {
  // Firefox
  try {
    const firefoxBase = join(homedir(), "Library", "Application Support", "Firefox", "Profiles");
    const entries = readdirSync(firefoxBase);
    const profile = entries.find((e) => e.endsWith(".default-release"));
    if (profile) {
      const temp = "/tmp/sp-usage-cookies.sqlite";
      const source = join(firefoxBase, profile, "cookies.sqlite");
      copyFileSync(source, temp);
      try { copyFileSync(source + "-wal", temp + "-wal"); } catch {}
      try { copyFileSync(source + "-shm", temp + "-shm"); } catch {}
      const output = execFileSync("sqlite3", ["-separator", "\t", temp,
        "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name = 'sessionKey' LIMIT 1"
      ], { encoding: "utf8", timeout: 3000 }).trim();
      unlinkSync(temp);
      try { unlinkSync(temp + "-wal"); } catch {}
      try { unlinkSync(temp + "-shm"); } catch {}
      if (output) return output;
    }
  } catch {}

  // Chrome (macOS)
  try {
    const password = execFileSync("security", [
      "find-generic-password", "-s", "Chrome Safe Storage", "-w"
    ], { encoding: "utf8", timeout: 5000 }).trim();
    const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const iv = Buffer.alloc(16, 0x20);
    const chromeDb = join(homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Cookies");
    const temp = "/tmp/sp-chrome-usage.sqlite";
    copyFileSync(chromeDb, temp);
    const hex = execFileSync("sqlite3", ["-separator", "\t", temp,
      "SELECT hex(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai%' AND name = 'sessionKey' LIMIT 1"
    ], { encoding: "utf8", timeout: 3000 }).trim();
    unlinkSync(temp);
    if (hex) {
      const buf = Buffer.from(hex, "hex");
      if (buf.length > 3 && buf.subarray(0, 3).toString() === "v10") {
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString("utf8");
      }
    }
  } catch {}

  return "";
}

// Fetch usage for a specific org
function fetchOrgUsage(orgId: string, sessionKey: string): Promise<any> {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: "claude.ai",
      path: "/api/organizations/" + orgId + "/usage",
      method: "GET",
      headers: { "Cookie": "sessionKey=" + sessionKey, "User-Agent": "Mozilla/5.0" },
    }, (upstream: any) => {
      const chunks: Buffer[] = [];
      upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstream.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve(null); }
      });
    });
    request.on("error", () => resolve(null));
    request.setTimeout(10000, () => { request.destroy(); resolve(null); });
    request.end();
  });
}

// Usage cache: { [orgId]: { data, fetchedAt } }
const usageCache: Record<string, { data: any; fetchedAt: number }> = {};
// Historical usage snapshots for burn rate: { [email]: { utilization, timestamp }[] }
const usageHistoryPath = join(dataDirectory, "usage-history.json");

function readUsageHistory(): Record<string, Array<{ utilization: number; timestamp: number }>> {
  try { return JSON.parse(readFileSync(usageHistoryPath, "utf8")); } catch { return {}; }
}

function writeUsageHistory(history: Record<string, Array<{ utilization: number; timestamp: number }>>) {
  writeFileSync(usageHistoryPath, JSON.stringify(history) + "\n");
}

const usageSnapshotPath = join(dataDirectory, "usage-snapshots.json");

function readSnapshots(): Record<string, any> {
  try { return JSON.parse(readFileSync(usageSnapshotPath, "utf8")); } catch { return {}; }
}

function writeSnapshot(email: string, data: any) {
  const snapshots = readSnapshots();
  snapshots[email] = { ...data, snapshotAt: Date.now() };
  writeFileSync(usageSnapshotPath, JSON.stringify(snapshots, null, 2) + "\n");
}

app.get("/api/claude-usage", async (_: Request, response: Response) => {
  const accounts = readAccounts();
  let tokens: Record<string, any> = {};
  try { tokens = JSON.parse(readFileSync(join(dataDirectory, "tokens.json"), "utf8")); } catch {}

  // Get current account
  let currentEmail = "";
  let currentOrgId = "";
  try {
    const auth = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 5000 }));
    currentEmail = auth.email || "";
    currentOrgId = auth.orgId || "";
  } catch {}

  const orgMap: Record<string, string> = {};
  for (const email of accounts) {
    if (tokens[email]?.orgId) orgMap[email] = tokens[email].orgId;
  }
  if (currentEmail && currentOrgId) orgMap[currentEmail] = currentOrgId;

  const now = Date.now();
  const results: Record<string, any> = {};
  const snapshots = readSnapshots();

  // Fetch live usage for the CURRENT account only (we have its session cookie)
  const sessionKey = getSessionKey();
  if (sessionKey && currentEmail && orgMap[currentEmail]) {
    const orgId = orgMap[currentEmail];
    if (!usageCache[orgId] || now - usageCache[orgId].fetchedAt > 60000) {
      const data = await fetchOrgUsage(orgId, sessionKey);
      if (data && !data.error) {
        usageCache[orgId] = { data, fetchedAt: now };
        writeSnapshot(currentEmail, data);

        // Track burn rate
        const history = readUsageHistory();
        if (!history[currentEmail]) history[currentEmail] = [];
        history[currentEmail].push({ utilization: data.five_hour?.utilization ?? 0, timestamp: now });
        if (history[currentEmail].length > 100) history[currentEmail] = history[currentEmail].slice(-100);
        writeUsageHistory(history);
      }
    }
    if (usageCache[orgId]) {
      results[currentEmail] = { ...usageCache[orgId].data, live: true };
    }
  }

  // For other accounts, use stored snapshots
  for (const email of accounts) {
    if (results[email]) continue;
    if (snapshots[email] && snapshots[email].five_hour) {
      const age = now - (snapshots[email].snapshotAt || 0);
      results[email] = {
        ...snapshots[email],
        live: false,
        staleMinutes: Math.round(age / 60000),
      };
    } else {
      results[email] = { error: "no data yet" };
    }
  }

  // Pooled: only the active account is burning capacity right now.
  // All accounts share the same rate limit ceiling, so pooled utilization =
  // active account's usage / total number of accounts (each is a full slot).
  // Accounts with snapshots contribute their last-known usage.
  const totalAccounts = accounts.length;
  const withData = Object.values(results).filter((r: any) => r.five_hour && !r.error);
  let sumFiveHour = 0;
  let sumSevenDay = 0;
  for (const r of withData) {
    sumFiveHour += (r as any).five_hour.utilization;
    sumSevenDay += (r as any).seven_day.utilization;
  }
  // Accounts without data are assumed idle (0% usage)
  const pooledFiveHour = totalAccounts > 0 ? Math.round(sumFiveHour / totalAccounts) : null;
  const pooledSevenDay = totalAccounts > 0 ? Math.round(sumSevenDay / totalAccounts) : null;

  // Swap estimate from burn rate
  let estimatedSwapMinutes: number | null = null;
  if (currentEmail) {
    const history = readUsageHistory();
    const entries = history[currentEmail] || [];
    if (entries.length >= 2) {
      const recent = entries.slice(-10);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const deltaUtil = last.utilization - first.utilization;
      const deltaMs = last.timestamp - first.timestamp;
      if (deltaUtil > 0 && deltaMs > 0) {
        const ratePerMs = deltaUtil / deltaMs;
        const remaining = 100 - last.utilization;
        estimatedSwapMinutes = Math.round(remaining / ratePerMs / 60000);
      }
    }
  }

  response.json({
    accounts: results,
    current: currentEmail,
    pooled: {
      fiveHour: pooledFiveHour !== null ? Math.round(pooledFiveHour) : null,
      sevenDay: pooledSevenDay !== null ? Math.round(pooledSevenDay) : null,
      accountCount: withData.length,
    },
    estimatedSwapMinutes,
  });
});

app.get("/api/auth", (_: Request, response: Response) => {
  execFile("claude", ["auth", "status"], { timeout: 5000 }, (error, stdout) => {
    if (error) {
      response.json({ authenticated: false });
    } else {
      try {
        response.json({ authenticated: true, ...JSON.parse(stdout) });
      } catch {
        response.json({ authenticated: true, raw: stdout });
      }
    }
  });
});

const distDirectory = join(__dirname, "dist");
if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
  app.get("/{*path}", (_: Request, response: Response) => {
    response.sendFile(join(distDirectory, "index.html"));
  });
}

const port = process.env.PORT || 3848;
app.listen(port, () => console.log("Superpowerd dashboard: http://localhost:" + port));
