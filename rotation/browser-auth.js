#!/usr/bin/env node
// Browser automation for Claude account rotation using Playwright.
//
// Auto-imports cookies from Firefox or Chrome so existing Google sessions
// are reused — no manual setup needed in most cases.
//
// If no browser cookies are found, run the one-time setup:
//   node browser-auth.js setup
//
// Usage:
//   node browser-auth.js login <email>
//   node browser-auth.js logout
//   node browser-auth.js setup

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILE_DIR = path.join(DATA_DIR, "browser");
const URL_FILE = path.join(os.tmpdir(), "superpowerd-auth-url");
const BROWSER_TRAP = path.join(os.tmpdir(), "superpowerd-browser-trap");

function log(message) {
  console.log("[" + new Date().toISOString() + "] " + message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    console.error("Playwright not installed. Run: cd " + path.join(__dirname, "..") + " && npm install");
    process.exit(1);
  }
}

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 900 },
  });
}

// =====================================================================
// Cookie import (Firefox + Chrome)
// =====================================================================

function findFirefoxProfile() {
  const candidates =
    process.platform === "darwin"
      ? [path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles")]
      : [
          path.join(os.homedir(), ".mozilla", "firefox"),
          path.join(os.homedir(), "snap", "firefox", "common", ".mozilla", "firefox"),
        ];

  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    try {
      const entries = fs.readdirSync(base);
      for (const suffix of [".default-release", ".default"]) {
        const match = entries.find((e) => e.endsWith(suffix));
        if (match && fs.existsSync(path.join(base, match, "cookies.sqlite"))) {
          return path.join(base, match);
        }
      }
    } catch {}
  }
  return null;
}

function findChromeProfile() {
  const candidates =
    process.platform === "darwin"
      ? [path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "Default")]
      : [
          path.join(os.homedir(), ".config", "google-chrome", "Default"),
          path.join(os.homedir(), ".config", "chromium", "Default"),
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Cookies"))) return candidate;
  }
  return null;
}

function readSqliteCookies(database, query) {
  const temp = path.join(os.tmpdir(), "superpowerd-cookies-" + Date.now() + ".sqlite");
  try {
    fs.copyFileSync(database, temp);
    for (const extension of ["-wal", "-shm"]) {
      try { fs.copyFileSync(database + extension, temp + extension); } catch {}
    }
    return execFileSync("sqlite3", ["-separator", "\t", temp, query], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return "";
  } finally {
    for (const extension of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(temp + extension); } catch {}
    }
  }
}

function readFirefoxCookies(profileDirectory) {
  const output = readSqliteCookies(
    path.join(profileDirectory, "cookies.sqlite"),
    "SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite " +
    "FROM moz_cookies " +
    "WHERE host LIKE '%google%' OR host LIKE '%googleapis%' " +
    "OR host LIKE '%claude%' OR host LIKE '%anthropic%'"
  );

  const cookies = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [name, value, host, cookiePath, expiry, isSecure, isHttpOnly, sameSite] = line.split("\t");
    cookies.push({
      name,
      value,
      domain: host.startsWith(".") ? host : "." + host,
      path: cookiePath || "/",
      expires: Number(expiry) || -1,
      secure: isSecure === "1",
      httpOnly: isHttpOnly === "1",
      sameSite: ["None", "Lax", "Strict"][Number(sameSite)] || "None",
    });
  }
  return cookies;
}

function getChromeDecryptionKey() {
  if (process.platform !== "darwin") return null;
  const crypto = require("crypto");
  try {
    // Reads "Chrome Safe Storage" from Keychain — macOS will prompt the user
    // to allow access (click "Allow" or "Always Allow")
    const password = execFileSync(
      "security", ["find-generic-password", "-s", "Chrome Safe Storage", "-w"],
      { encoding: "utf8", timeout: 10000 }
    ).trim();
    return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  } catch {
    return null;
  }
}

function decryptChromeValue(encrypted, key) {
  if (!encrypted || !key) return null;
  const crypto = require("crypto");
  const buffer = Buffer.from(encrypted, "hex");
  // Chrome prefixes encrypted values with "v10" (3 bytes)
  if (buffer.length < 4) return null;
  const prefix = buffer.subarray(0, 3).toString("utf8");
  if (prefix !== "v10") return null;
  const ciphertext = buffer.subarray(3);
  const iv = Buffer.alloc(16, 0x20); // 16 bytes of space (0x20)
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function readChromeCookies(profileDirectory) {
  const filter =
    "WHERE host_key LIKE '%google%' OR host_key LIKE '%googleapis%' " +
    "OR host_key LIKE '%claude%' OR host_key LIKE '%anthropic%'";

  // On macOS, values are encrypted — decrypt via Keychain
  if (process.platform === "darwin") {
    const key = getChromeDecryptionKey();
    if (!key) {
      log("Could not get Chrome decryption key from Keychain");
      return [];
    }

    const output = readSqliteCookies(
      path.join(profileDirectory, "Cookies"),
      "SELECT name, hex(encrypted_value), host_key, path, expires_utc, is_secure, is_httponly, samesite " +
      "FROM cookies " + filter
    );

    const cookies = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [name, hexValue, host, cookiePath, expiry, isSecure, isHttpOnly, sameSite] = line.split("\t");
      const value = decryptChromeValue(hexValue, key);
      if (!value) continue;
      cookies.push({
        name,
        value,
        domain: host.startsWith(".") ? host : "." + host,
        path: cookiePath || "/",
        expires: Number(expiry) ? Math.floor(Number(expiry) / 1000000 - 11644473600) : -1,
        secure: isSecure === "1",
        httpOnly: isHttpOnly === "1",
        sameSite: ["None", "Lax", "Strict"][Number(sameSite)] || "None",
      });
    }
    return cookies;
  }

  // On Linux, values are either unencrypted or use a fixed key
  const output = readSqliteCookies(
    path.join(profileDirectory, "Cookies"),
    "SELECT name, value, host_key, path, expires_utc, is_secure, is_httponly, samesite " +
    "FROM cookies " + filter
  );

  const cookies = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [name, value, host, cookiePath, expiry, isSecure, isHttpOnly, sameSite] = line.split("\t");
    if (!value) continue;
    cookies.push({
      name,
      value,
      domain: host.startsWith(".") ? host : "." + host,
      path: cookiePath || "/",
      expires: Number(expiry) ? Math.floor(Number(expiry) / 1000000 - 11644473600) : -1,
      secure: isSecure === "1",
      httpOnly: isHttpOnly === "1",
      sameSite: ["None", "Lax", "Strict"][Number(sameSite)] || "None",
    });
  }
  return cookies;
}

async function importBrowserCookies(context) {
  // Try Firefox first (unencrypted cookies on all platforms)
  const firefoxProfile = findFirefoxProfile();
  if (firefoxProfile) {
    const cookies = readFirefoxCookies(firefoxProfile);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      log("Imported " + cookies.length + " cookies from Firefox");
      return true;
    }
  }

  // Try Chrome (macOS: decrypts via Keychain prompt, Linux: reads directly)
  const chromeProfile = findChromeProfile();
  if (chromeProfile) {
    const cookies = readChromeCookies(chromeProfile);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      log("Imported " + cookies.length + " cookies from Chrome");
      return true;
    }
  }

  log("No browser cookies found — run 'setup' to log in manually");
  return false;
}

// =====================================================================
// Page interaction helpers
// =====================================================================

async function clickByText(page, patterns, options) {
  const timeout = (options && options.timeout) || 10000;
  for (const pattern of patterns) {
    for (const role of ["button", "link", "menuitem"]) {
      try {
        await page.getByRole(role, { name: new RegExp(pattern, "i") }).first()
          .click({ timeout: role === "button" ? timeout : 2000 });
        return true;
      } catch {}
    }
  }
  return false;
}

async function selectAccount(page, email) {
  log("Selecting " + email + "...");
  await sleep(2000);

  for (const selector of ['[data-identifier="' + email + '"]', '[data-email="' + email + '"]']) {
    try {
      await page.locator(selector).first().click({ timeout: 3000 });
      log("Selected via attribute");
      return true;
    } catch {}
  }

  try {
    const element = page.getByText(email, { exact: true }).first();
    const parent = element.locator("xpath=ancestor::*[@role='link' or @tabindex or self::a or self::li]").first();
    await parent.click({ timeout: 3000 });
    log("Selected via text (parent)");
    return true;
  } catch {}

  try {
    await page.getByText(email, { exact: true }).first().click({ timeout: 3000 });
    log("Selected via text (direct)");
    return true;
  } catch {
    log("Could not find " + email + " in chooser");
    return false;
  }
}

// =====================================================================
// Commands
// =====================================================================

async function setup() {
  log("Opening browser for account setup...");
  log("Log into ALL your Google accounts, then close the browser window.");

  const context = await launchBrowser();
  const page = await context.newPage();
  await page.goto("https://accounts.google.com");

  await new Promise((resolve) => context.on("close", resolve));
  log("Setup complete. Sessions saved.");
}

async function signOut(page) {
  log("Navigating to claude.ai...");
  await page.goto("https://claude.ai", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2000);

  if (page.url().includes("/login")) {
    log("Already signed out");
    return;
  }

  log("Looking for sign out...");
  await clickByText(page, ["menu", "profile", "account"], { timeout: 3000 });
  await sleep(1000);

  if (await clickByText(page, ["log out", "sign out"], { timeout: 5000 })) {
    log("Clicked sign out");
    await page.waitForURL(/login|accounts\.google/, { timeout: 15000 }).catch(() => {});
    await sleep(2000);
    return;
  }

  log("Trying /settings...");
  await page.goto("https://claude.ai/settings", { waitUntil: "domcontentloaded", timeout: 15000 });
  await sleep(2000);
  if (await clickByText(page, ["log out", "sign out"], { timeout: 5000 })) {
    await sleep(3000);
    return;
  }

  log("Trying API logout...");
  await page.evaluate(async () => {
    for (const url of ["/api/auth/logout", "/auth/logout"]) {
      try { await fetch(url, { method: "POST", credentials: "same-origin" }); return; } catch {}
    }
  });
  await sleep(1000);
  await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(2000);

  if (!page.url().includes("/login")) {
    log("Clearing cookies...");
    await page.context().clearCookies({ domain: ".claude.ai" });
    await page.context().clearCookies({ domain: "claude.ai" });
    await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await sleep(2000);
  }

  log("Signed out");
}

async function logout() {
  const context = await launchBrowser();
  const page = await context.newPage();
  try { await signOut(page); } finally { await context.close(); }
}

async function login(email) {
  log("Starting login for " + email);

  const context = await launchBrowser();

  // Import cookies from the user's real browser if Playwright has none
  const existing = await context.cookies("https://accounts.google.com");
  if (existing.length === 0) {
    await importBrowserCookies(context);
  }

  const page = await context.newPage();

  try {
    await signOut(page);

    log("Signing into claude.ai...");
    if (!page.url().includes("/login")) {
      await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded", timeout: 15000 });
      await sleep(2000);
    }

    await clickByText(page, ["google", "continue with g"], { timeout: 8000 });
    await sleep(3000);

    if (page.url().includes("accounts.google.com")) {
      if (!await selectAccount(page, email)) {
        log("Waiting 30s for manual selection...");
        await sleep(30000);
      }
    }

    await sleep(3000);
    if (page.url().includes("accounts.google.com")) {
      await clickByText(page, ["allow", "continue", "accept"], { timeout: 8000 });
      await sleep(3000);
    }

    try {
      await page.waitForURL(/claude\.ai(?!.*login)/, { timeout: 30000 });
      log("Signed into claude.ai as " + email);
    } catch {
      log("Redirect timed out. URL: " + page.url());
    }

    // Start `claude auth login` and intercept the URL it tries to open
    log("Starting claude auth login...");
    const trap = writeBrowserTrap();
    fs.rmSync(URL_FILE, { force: true });

    const child = spawn("claude", ["auth", "login", "--email", email], {
      env: { ...process.env, BROWSER: trap },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });

    const authURL = await waitForAuthURL(15000);
    if (authURL) {
      log("Captured OAuth URL");
      await page.goto(authURL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3000);

      if (page.url().includes("accounts.google.com")) {
        await selectAccount(page, email);
        await sleep(3000);
      }
      if (page.url().includes("accounts.google.com")) {
        await clickByText(page, ["allow", "continue", "accept"], { timeout: 5000 });
        await sleep(3000);
      }

      try {
        await page.waitForURL(/localhost/, { timeout: 30000 });
        log("OAuth callback completed");
      } catch {
        log("Callback wait timed out. URL: " + page.url());
      }
    } else {
      log("No OAuth URL captured — may have auto-completed");
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 30000);
      child.on("close", () => { clearTimeout(timer); resolve(); });
    });

    log("CLI login finished");
  } finally {
    await context.close();
    fs.rmSync(URL_FILE, { force: true });
    fs.rmSync(BROWSER_TRAP, { force: true });
    fs.rmSync(BROWSER_TRAP + ".cmd", { force: true });
  }
}

// =====================================================================
// Helpers
// =====================================================================

function writeBrowserTrap() {
  if (process.platform === "win32") {
    const script = '@echo off\r\necho %1 > "' + URL_FILE + '"\r\n';
    fs.writeFileSync(BROWSER_TRAP + ".cmd", script);
    return BROWSER_TRAP + ".cmd";
  }
  fs.writeFileSync(BROWSER_TRAP, '#!/bin/sh\necho "$1" > "' + URL_FILE + '"\n', { mode: 0o755 });
  return BROWSER_TRAP;
}

async function waitForAuthURL(timeout) {
  const start = Date.now();
  while (Date.now() - start < (timeout || 30000)) {
    if (fs.existsSync(URL_FILE)) {
      const url = fs.readFileSync(URL_FILE, "utf8").trim();
      fs.unlinkSync(URL_FILE);
      if (url.startsWith("http")) return url;
    }
    await sleep(300);
  }
  return null;
}

// =====================================================================
// Main
// =====================================================================

async function main() {
  const command = process.argv[2];
  const email = process.argv[3];

  switch (command) {
    case "setup":
      await setup();
      break;
    case "logout":
      await logout();
      break;
    case "login":
      if (!email) {
        console.error("Usage: browser-auth.js login <email>");
        process.exit(1);
      }
      await login(email);
      break;
    default:
      console.error("Usage: browser-auth.js <setup|logout|login> [email]");
      console.error("");
      console.error("  setup          Open browser to log into Google accounts (first time)");
      console.error("  logout         Sign out of claude.ai");
      console.error("  login <email>  Sign out, re-auth CLI, sign in as <email>");
      console.error("");
      console.error("Cookies are auto-imported from Firefox or Chrome — no setup needed");
      console.error("if you're already logged into Google in either browser.");
      process.exit(1);
  }
}

main().catch(function (error) {
  console.error("Fatal:", error.message);
  process.exit(1);
});
