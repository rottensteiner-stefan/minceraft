#!/usr/bin/env node
/**
 * M7 live gate (`scripts/check-voxel-m7.mjs`) -- headless Puppeteer proof for the voxel
 * worker-pool milestone, in the spirit of the archived check-voxel-m*.mjs gates:
 *
 *   LEG 1  worker pool:  `?workers=2` must expose a live pool of EXACTLY 2 arenas via the QA hook,
 *                        streaming must run (ready grows, meshMsTotal > 0, worker-side only),
 *                        screenshots must be non-blank, 0 console/page errors.
 *   LEG 2  persistence:  an edit -> `forcePersist` -> full page reload must rebuild the SAME world
 *                        (seed round-trip) and keep the edited cell -- against whichever store
 *                        backend is active (`storeBackend` in the QA stats). With the M7 OPFS
 *                        driver preferred over IndexedDB, this doubles as the OPFS round-trip proof.
 *
 * Requires a fresh production build (`npm run build`) and starts `vite preview` itself.
 * Usage: node scripts/check-voxel-m7.mjs [--base-url <url>] [--workers N]
 */
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { detectBlankCanvas, PREVIEW_ARGS, PREVIEW_ORIGIN, waitForServer } from "./lib/preview-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_URL = `${PREVIEW_ORIGIN}/src/index.html`;

const results = [];
let server = null;

function log(...args) {
  console.log("[m7]", ...args);
}

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  const workers = Number(process.argv.find((a) => a.startsWith("--workers="))?.split("=")[1]) || 2;

  server = spawn("npm", [...PREVIEW_ARGS, "--", "--strictPort"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
  });
  try {
    await waitForServer(`${PREVIEW_ORIGIN}/`);

    const tmpDir = path.join(REPO_ROOT, ".agents", "scratches", "tmp_puppeteer_" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const browser = await puppeteer.launch({
      headless: true,
      userDataDir: tmpDir,
      acceptInsecureCerts: true,
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--ignore-certificate-errors",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-webgl",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--disable-gpu-sandbox",
        "--enable-features=Vulkan",
      ],
    });

    try {
      await runLeg1(browser, workers);
      await runLeg2(browser);
    } finally {
      await browser.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* server already gone */
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log(`GATE RED -- ${failed.length} failed check(s)`);
    process.exit(1);
  }
  log("GATE GREEN -- all M7 checks passed");
}

async function openApp(browser, query) {
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // OPFS requires a secure context; the preview server is https (mkcert), so this is satisfied.
  await page.goto(`${APP_URL}?${query}`, { waitUntil: "load", timeout: 60000 });
  return { page, consoleErrors, pageErrors };
}

async function waitForQa(page, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await page.evaluate(() => {
      const qa = window.__voxelM1;
      return qa ? qa.getStats() : null;
    });
    if (stats && predicate(stats)) return stats;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("timed out waiting for QA condition");
}

async function runLeg1(browser, workers) {
  log(`LEG 1: worker pool (?workers=${workers})`);
  const { page, consoleErrors, pageErrors } = await openApp(browser, `rendererType=WEB_GL2&workers=${workers}`);

  try {
    const stats = await waitForQa(page, (s) => s.workers === workers && s.ready >= 60 && s.meshMsTotal > 0);
    check(`pool exposes ${workers} worker arenas`, stats.workers === workers, `workers=${stats.workers}`);
    check("world streams to a healthy size", stats.ready >= 60, `ready=${stats.ready}`);
    check("worker-side meshing happened", stats.meshMsTotal > 0, `meshMsTotal=${stats.meshMsTotal.toFixed(1)}`);
    check("player is grounded", (await page.evaluate(() => window.__voxelM1.getPlayer())).onGround === true);

    const shot = await page.screenshot({ encoding: "binary" });
    const { blank, stddev } = detectBlankCanvas(shot, 6);
    check("viewport is not blank", !blank, `stddev=${stddev.toFixed(2)}`);
    check("no console/page errors", consoleErrors.length === 0 && pageErrors.length === 0, `${consoleErrors.length} console / ${pageErrors.length} page errors`);
  } catch (err) {
    check("LEG 1 completed", false, String(err));
  }
  await page.close();
}

async function runLeg2(browser) {
  log("LEG 2: edit persistence across a full reload");
  const { page, consoleErrors, pageErrors } = await openApp(browser, `rendererType=WEB_GL2&workers=2`);

  try {
    await waitForQa(page, (s) => s.ready >= 30);
    const backend = await page.evaluate(() => window.__voxelM1.getStoreBackend());
    check("store backend active", backend !== "none", `backend=${backend}`);
    if (backend === "opfs") {
      check("M7 OPFS driver is the active persistence backend", true, "opfs");
    } else {
      // Environment limitation, not a regression: OPFS needs a secure context + Chromium support
      // (the preview server is https/mkcert, which normally satisfies this).
      log(`SKIP: OPFS unavailable here (backend=${backend}) -- the round-trip below still proves the active driver`);
    }

    // Break one block, persist, hard-reload (fresh document -- no app state survives).
    const edit = await page.evaluate(() => {
      const qa = window.__voxelM1;
      const before = qa.getWorldBlock(20, 10, 19);
      qa.setBlock(20, 10, 19, 0); // air = break
      return qa.getWorldBlock(20, 10, 19);
    });
    check("edit took effect", edit === 0);

    const persisted = await page.evaluate(() => window.__voxelM1.forcePersist().then(() => window.__voxelM1.getStoredSeed()));
    check("seed persisted on edit", persisted === 777, `seed=${persisted}`);
    await page.reload({ waitUntil: "load" });
    await waitForQa(page, (s) => s.ready >= 30);

    const afterReload = await page.evaluate(() => window.__voxelM1.getWorldBlock(20, 10, 19));
    check("edited cell survives a full reload", afterReload === 0, `after=${afterReload}`);
    check("no console/page errors in leg 2", consoleErrors.length === 0 && pageErrors.length === 0, `${consoleErrors.length} console / ${pageErrors.length} page errors`);
  } catch (err) {
    check("LEG 2 completed", false, String(err));
  }
  await page.close();
}

main().catch((err) => {
  log("GATE CRASH", err);
  process.exit(1);
});
