import express, { type Request, type Response } from "express";
import { readFileSync, existsSync } from "fs";
import { execFile, spawn } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(__dirname, "..");
const dataDirectory = join(projectDirectory, "data");
const accountsPath = join(projectDirectory, "accounts.conf");
const statePath = join(dataDirectory, "state.json");
const monitorPidPath = join(dataDirectory, "monitor.pid");
const monitorLogPath = join(dataDirectory, "monitor.log");
const rotatePath = join(projectDirectory, "rotation", "rotate");
const monitorPath = join(projectDirectory, "rotation", "monitor");

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
