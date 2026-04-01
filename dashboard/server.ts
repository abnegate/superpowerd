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
  let models: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }> = [];
  let hourCounts: Record<string, number> = {};
  let longestSession: any = null;
  let speculationSaved = 0;
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

    hourCounts = stats.hourCounts || {};
    longestSession = stats.longestSession || null;
    speculationSaved = stats.totalSpeculationTimeSavedMs || 0;

    // Per-model breakdown (inside try — stats is scoped here)
    if (stats.modelUsage) {
      for (const [model, u] of Object.entries(stats.modelUsage) as Array<[string, Record<string, number>]>) {
        const rates = pricing[model] || fallbackPricing;
        const cost = ((u.inputTokens || 0) / 1e6) * rates.input
          + ((u.outputTokens || 0) / 1e6) * rates.output
          + ((u.cacheReadInputTokens || 0) / 1e6) * rates.cacheRead
          + ((u.cacheCreationInputTokens || 0) / 1e6) * rates.cacheWrite;
        models.push({
          model: model.replace("claude-", "").replace(/-\d{8}$/, ""),
          input: u.inputTokens || 0,
          output: u.outputTokens || 0,
          cacheRead: u.cacheReadInputTokens || 0,
          cacheWrite: u.cacheCreationInputTokens || 0,
          cost: Math.round(cost * 100) / 100,
        });
      }
      models.sort((a, b) => b.cost - a.cost);
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

  // Token expiry from live keychain (not the stale stored copy)
  let tokenExpiry: string | null = null;
  try {
    const password = execFileSync("security", [
      "find-generic-password", "-s", "Claude Code-credentials", "-w"
    ], { encoding: "utf8", timeout: 5000 }).trim();
    const credentials = JSON.parse(password);
    if (credentials.claudeAiOauth?.expiresAt) {
      tokenExpiry = new Date(credentials.claudeAiOauth.expiresAt).toISOString();
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
    models,
    hourCounts,
    longestSession,
    speculationSaved,
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
        const decrypted = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString("utf8");
        // Validate: session keys are printable ASCII starting with sk-ant-sid
        if (/^[\x20-\x7e]+$/.test(decrypted)) return decrypted;
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

  // For other accounts, use stored snapshots — but zero out utilization
  // if the reset window has passed since the snapshot was taken
  for (const email of accounts) {
    if (results[email]) continue;
    if (snapshots[email] && snapshots[email].five_hour) {
      const snap = { ...snapshots[email] };
      const age = now - (snap.snapshotAt || 0);

      // If the 5-hour reset time has passed, utilization is 0
      if (snap.five_hour?.resets_at) {
        const resetTime = new Date(snap.five_hour.resets_at).getTime();
        if (now > resetTime) {
          snap.five_hour = { ...snap.five_hour, utilization: 0, resets_at: null };
        }
      }

      // Same for 7-day
      if (snap.seven_day?.resets_at) {
        const resetTime = new Date(snap.seven_day.resets_at).getTime();
        if (now > resetTime) {
          snap.seven_day = { ...snap.seven_day, utilization: 0, resets_at: null };
        }
      }

      results[email] = {
        ...snap,
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
      accountCount: totalAccounts,
    },
    estimatedSwapMinutes,
  });
});

// Per-session cost tracking
const pricingRates = {
  input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
};

app.get("/api/sessions", (_: Request, response: Response) => {
  const sessions: Array<{
    pane: number | null;
    session: string;
    cwd: string;
    repo: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    messages: number;
  }> = [];

  // Map TTY -> pane ID for active panes
  let ttyToPaneId: Record<string, number> = {};
  try {
    const list = execFileSync("wezterm", ["cli", "list", "--format", "json"], {
      encoding: "utf8", timeout: 5000,
    });
    const panes = JSON.parse(list);
    for (const p of panes) {
      const tty = (p.tty_name || "").replace("/dev/", "");
      if (tty) ttyToPaneId[tty] = p.pane_id;
    }
  } catch {}

  // Map PID -> TTY from ps
  let pidToTty: Record<string, string> = {};
  try {
    const ps = execFileSync("ps", ["-eo", "pid,tty,comm"], { encoding: "utf8", timeout: 3000 });
    for (const line of ps.split("\n")) {
      if (line.includes("claude")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) pidToTty[parts[0]] = parts[1];
      }
    }
  } catch {}

  // Read each active session file
  try {
    const files = readdirSync(sessionsDirectory).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const session = JSON.parse(readFileSync(join(sessionsDirectory, file), "utf8"));
        process.kill(session.pid, 0); // throws if not alive

        const tty = pidToTty[String(session.pid)] || "";
        const paneId = tty ? (ttyToPaneId[tty] ?? null) : null;
        const repo = (session.cwd || "").split("/").pop() || session.cwd || "";

        // Find the session's transcript file and sum usage
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, messages = 0;
        const projectDirs = [
          join(homedir(), ".claude", "projects", "-" + (session.cwd || "").replace(/\//g, "-")),
          join(homedir(), ".claude", "projects", "-Users-" + (session.cwd || "").split("/Users/")[1]?.replace(/\//g, "-")),
        ];

        for (const projectDir of projectDirs) {
          const transcript = join(projectDir, session.sessionId + ".jsonl");
          if (!existsSync(transcript)) continue;

          const content = readFileSync(transcript, "utf8");
          for (const line of content.split("\n")) {
            if (!line.includes('"usage"')) continue;
            try {
              const entry = JSON.parse(line);
              const u = entry.usage || entry.message?.usage;
              if (!u) continue;
              input += u.input_tokens || 0;
              output += u.output_tokens || 0;
              cacheRead += u.cache_read_input_tokens || 0;
              cacheWrite += u.cache_creation_input_tokens || 0;
              messages++;
            } catch {}
          }
          break;
        }

        const cost = (input / 1e6) * pricingRates.input
          + (output / 1e6) * pricingRates.output
          + (cacheRead / 1e6) * pricingRates.cacheRead
          + (cacheWrite / 1e6) * pricingRates.cacheWrite;

        sessions.push({
          pane: paneId,
          session: session.sessionId,
          cwd: session.cwd,
          repo,
          input, output, cacheRead, cacheWrite,
          cost: Math.round(cost * 100) / 100,
          messages,
        });
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => b.cost - a.cost);

  response.json({
    sessions,
    totalCost: Math.round(sessions.reduce((s, x) => s + x.cost, 0) * 100) / 100,
  });
});

// Historical session data from the index
const sessionIndexPath = join(dataDirectory, "session-index.json");

app.get("/api/history", (_: Request, response: Response) => {
  if (!existsSync(sessionIndexPath)) {
    response.json({ error: "run: node rotation/index-sessions.js" });
    return;
  }

  const index = JSON.parse(readFileSync(sessionIndexPath, "utf8"));

  // Group by repo
  const repos: Record<string, { sessions: number; messages: number; cost: number; output: number; cacheRead: number }> = {};
  let totalCost = 0;

  for (const session of Object.values(index.sessions) as any[]) {
    const repo = session.repo || "unknown";
    if (!repos[repo]) repos[repo] = { sessions: 0, messages: 0, cost: 0, output: 0, cacheRead: 0 };
    repos[repo].sessions += 1;
    repos[repo].messages += session.messages || 0;
    repos[repo].cost += session.cost || 0;
    repos[repo].output += session.output || 0;
    repos[repo].cacheRead += session.cacheRead || 0;
    totalCost += session.cost || 0;
  }

  const sorted = Object.entries(repos)
    .map(([repo, stats]) => ({ repo, ...stats, cost: Math.round(stats.cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);

  // Daily cost breakdown (group sessions by start date)
  const daily: Record<string, number> = {};
  for (const session of Object.values(index.sessions) as any[]) {
    if (!session.startedAt) continue;
    const date = new Date(session.startedAt).toISOString().slice(0, 10);
    daily[date] = (daily[date] || 0) + (session.cost || 0);
  }
  const dailyCosts = Object.entries(daily)
    .map(([date, cost]) => ({ date, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  response.json({
    totalSessions: index.totalSessions,
    totalCost: Math.round(totalCost * 100) / 100,
    indexedAt: index.indexedAt,
    repos: sorted,
    dailyCosts,
  });
});

// Tool usage breakdown from session index
app.get("/api/tools", (_: Request, response: Response) => {
  const tools: Record<string, number> = {};
  let filesScanned = 0;

  try {
    const projectDirs = readdirSync(join(homedir(), ".claude", "projects"));
    for (const dir of projectDirs) {
      const fullDir = join(homedir(), ".claude", "projects", dir);
      let files: string[];
      try { files = readdirSync(fullDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filepath = join(fullDir, file);
        try {
          const stat = statSync(filepath);
          // Only scan files modified in last 60 days and under 50MB
          if (Date.now() - stat.mtimeMs > 60 * 86400000 || stat.size > 50_000_000) continue;

          const content = readFileSync(filepath, "utf8");
          for (const line of content.split("\n")) {
            if (!line.includes('"tool_use"')) continue;
            // Extract tool name from: "type":"tool_use","id":"...","name":"Bash"
            const match = line.match(/"type":"tool_use"[^}]*"name":"([^"]+)"/);
            if (match) {
              tools[match[1]] = (tools[match[1]] || 0) + 1;
            }
          }
          filesScanned++;
        } catch {}
      }
    }
  } catch {}

  const sorted = Object.entries(tools)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  response.json({ tools: sorted, filesScanned });
});

// Extended history from history.jsonl (goes back months)
const historyJsonlPath = join(homedir(), ".claude", "history.jsonl");

app.get("/api/history-extended", (_: Request, response: Response) => {
  if (!existsSync(historyJsonlPath)) {
    response.json({ error: "no history.jsonl" });
    return;
  }

  const content = readFileSync(historyJsonlPath, "utf8");
  const daily: Record<string, number> = {};
  const monthly: Record<string, number> = {};
  const repos: Record<string, number> = {};
  const hourly: Record<number, number> = {};
  let total = 0;
  let firstDate = "";
  let lastDate = "";

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.timestamp) continue;
      const date = new Date(entry.timestamp);
      const day = date.toISOString().slice(0, 10);
      const month = day.slice(0, 7);
      const hour = date.getHours();
      const repo = (entry.project || "").split("/").pop() || "other";

      daily[day] = (daily[day] || 0) + 1;
      monthly[month] = (monthly[month] || 0) + 1;
      repos[repo] = (repos[repo] || 0) + 1;
      hourly[hour] = (hourly[hour] || 0) + 1;
      total++;

      if (!firstDate || day < firstDate) firstDate = day;
      if (!lastDate || day > lastDate) lastDate = day;
    } catch {}
  }

  const dailyPrompts = Object.entries(daily)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const monthlyPrompts = Object.entries(monthly)
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const topRepos = Object.entries(repos)
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count);

  // Streaks (consecutive days with activity)
  const activeDays = new Set(Object.keys(daily));
  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 0;
  const allDates: string[] = [];
  if (firstDate && lastDate) {
    const cursor = new Date(firstDate);
    const end = new Date(lastDate);
    while (cursor <= end) {
      allDates.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const date of allDates) {
    if (activeDays.has(date)) {
      streak++;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      streak = 0;
    }
  }
  // Current streak (counting back from today)
  currentStreak = 0;
  for (let i = allDates.length - 1; i >= 0; i--) {
    if (activeDays.has(allDates[i])) currentStreak++;
    else break;
  }

  // Day x hour grid for heatmap
  const heatmap: Record<string, Record<number, number>> = {};
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.timestamp) continue;
      const date = new Date(entry.timestamp);
      const day = date.toISOString().slice(0, 10);
      const hour = date.getHours();
      if (!heatmap[day]) heatmap[day] = {};
      heatmap[day][hour] = (heatmap[day][hour] || 0) + 1;
    } catch {}
  }

  // Convert to flat array for the frontend: [{date, hour, count}, ...]
  const heatmapData: Array<{ date: string; hour: number; count: number }> = [];
  for (const [date, hours] of Object.entries(heatmap)) {
    for (let h = 0; h < 24; h++) {
      if (hours[h]) heatmapData.push({ date, hour: h, count: hours[h] });
    }
  }

  response.json({
    total,
    firstDate,
    lastDate,
    daysActive: Object.keys(daily).length,
    dailyPrompts,
    monthlyPrompts,
    topRepos,
    hourly,
    heatmapData,
    streaks: { current: currentStreak, longest: longestStreak },
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

// Re-index sessions every 5 minutes
const indexScript = join(projectDirectory, "rotation", "index-sessions.js");
function reindex() {
  execFile("node", [indexScript], { timeout: 120000 }, () => {});
}
reindex();
setInterval(reindex, 300000);

const port = process.env.PORT || 3848;
app.listen(port, () => console.log("Superpowerd dashboard: http://localhost:" + port));
