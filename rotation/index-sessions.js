#!/usr/bin/env node
// Index all historical session JSONL files into a compact summary.
// Scans ~/.claude/projects/*/*.jsonl, extracts token usage per session,
// and writes data/session-index.json.
//
// Usage:
//   node index-sessions.js           # Full scan
//   node index-sessions.js --watch   # Re-index every 5 minutes

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const INDEX_FILE = path.join(__dirname, "..", "data", "session-index.json");

function log(message) {
  console.log("[" + new Date().toISOString() + "] " + message);
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); } catch { return { sessions: {}, indexedAt: null }; }
}

function writeIndex(index) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index) + "\n");
}

function extractRepo(projectDir) {
  // -Users-jakebarnby-Local-cloud -> cloud
  const parts = projectDir.replace(/^-/, "").split("-");
  const localIndex = parts.indexOf("Local");
  if (localIndex >= 0 && localIndex < parts.length - 1) return parts[localIndex + 1];
  return parts[parts.length - 1] || "unknown";
}

function processSession(filepath) {
  const content = fs.readFileSync(filepath, "utf8");
  const lines = content.split("\n");

  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, messages = 0;
  let startedAt = null, endedAt = null;
  let cwd = null;

  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);

      // Get timestamps
      if (entry.timestamp && !startedAt) startedAt = entry.timestamp;
      if (entry.timestamp) endedAt = entry.timestamp;

      // Get CWD from first entry
      if (entry.cwd && !cwd) cwd = entry.cwd;

      // Sum usage
      const u = entry.usage || entry.message?.usage;
      if (u) {
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheWrite += u.cache_creation_input_tokens || 0;
        messages++;
      }
    } catch {}
  }

  if (messages === 0) return null;

  const cost = (input / 1e6) * 5 + (output / 1e6) * 25 + (cacheRead / 1e6) * 0.5 + (cacheWrite / 1e6) * 6.25;

  return {
    input, output, cacheRead, cacheWrite, messages,
    cost: Math.round(cost * 100) / 100,
    startedAt, endedAt, cwd,
  };
}

function indexAll() {
  const index = readIndex();
  const existing = new Set(Object.keys(index.sessions));
  let added = 0, skipped = 0;

  let projectDirs;
  try { projectDirs = fs.readdirSync(PROJECTS_DIR); } catch { log("No projects directory"); return; }

  for (const projectDir of projectDirs) {
    const fullDir = path.join(PROJECTS_DIR, projectDir);
    let files;
    try { files = fs.readdirSync(fullDir); } catch { continue; }

    const repo = extractRepo(projectDir);

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(".jsonl", "");

      // Skip if already indexed and file hasn't changed
      if (existing.has(sessionId)) {
        const stat = fs.statSync(path.join(fullDir, file));
        const cached = index.sessions[sessionId];
        if (cached && cached.size === stat.size) {
          skipped++;
          continue;
        }
      }

      try {
        const stat = fs.statSync(path.join(fullDir, file));
        const result = processSession(path.join(fullDir, file));
        if (result) {
          index.sessions[sessionId] = { ...result, repo, size: stat.size };
          added++;
        }
      } catch {}
    }

    // Also check subagent directories
    for (const file of files) {
      const subDir = path.join(fullDir, file, "subagents");
      if (!fs.existsSync(subDir)) continue;
      try {
        for (const subFile of fs.readdirSync(subDir)) {
          if (!subFile.endsWith(".jsonl")) continue;
          const sessionId = subFile.replace(".jsonl", "");
          if (existing.has(sessionId)) { skipped++; continue; }
          try {
            const stat = fs.statSync(path.join(subDir, subFile));
            const result = processSession(path.join(subDir, subFile));
            if (result) {
              index.sessions[sessionId] = { ...result, repo, subagent: true, size: stat.size };
              added++;
            }
          } catch {}
        }
      } catch {}
    }
  }

  index.indexedAt = new Date().toISOString();
  index.totalSessions = Object.keys(index.sessions).length;
  writeIndex(index);
  log("Indexed " + added + " new, " + skipped + " unchanged. Total: " + index.totalSessions);
}

if (process.argv.includes("--watch")) {
  indexAll();
  setInterval(indexAll, 300000);
} else {
  indexAll();
}
