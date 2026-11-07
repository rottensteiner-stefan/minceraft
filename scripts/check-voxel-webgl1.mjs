#!/usr/bin/env node
/**
 * WebGL1 tier live gate (`check-voxel-webgl1.mjs`) -- headless Puppeteer proof for the WebGL1
 * 2D-atlas fallback of the Minceraft (M6-Nachtrag Part 2; see the app docs/log.md):
 *
 *   LEG 1  WebGL1 boots & plays: `?rendererType=WEB_GL1` must come up on a REAL WebGL1 context
 *          (not WebGL2/WebGPU), stream the world (ready grows, worker meshing), keep the player
 *          grounded and render terrain -- 0 console/page errors (a failing GLSL100 pair would
 *          surface as console program-link errors and as a blank canvas).
 *   LEG 2  pinned-view determinism: the `?look=` dev param must be honoured (read back through the
 *          `getCamera` QA hook) so captures are reproducible, and the down-looking terrain view
 *          must contain textured terrain pixels (grass/dirt readback) -- the honest proof the
 *          2D-atlas GLSL100 material draws the block tiles, not a solid or empty frame.
 *
 * Requires a fresh production build (`npm run build`) and starts `vite preview` itself.
 * Usage: node scripts/check-voxel-webgl1.mjs [--base-url <url>]
 */
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import puppeteer from "puppeteer";
import { detectBlankCanvas, PREVIEW_ARGS, PREVIEW_ORIGIN, waitForServer } from "./lib/preview-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_URL = `${PREVIEW_ORIGIN}/src/index.html`;

const results = [];
let server = null;

function log(...args) {
  console.log("[webgl1]", ...args);
}

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  server = spawn("npm", [...PREVIEW_ARGS, "--", "--strictPort"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
  });
  try {
    await waitForServer(`${PREVIEW_ORIGIN}/`);

    const tmpDir = path.join(__dirname, "tmp_puppeteer_" + Date.now());
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
      ],
    });

    try {
      await runLeg1(browser);
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
  log("GATE GREEN -- all WebGL1 checks passed");
}

async function openApp(browser, query) {
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
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

async function runLeg1(browser) {
  log("LEG 1: WebGL1 boots, streams, plays (real WebGL1 context)");
  const { page, consoleErrors, pageErrors } = await openApp(
    browser,
    "rendererType=WEB_GL1&workers=2&time=0.25",
  );

  try {
    const stats = await waitForQa(page, (s) => s.workers === 2 && s.ready >= 60 && s.meshMsTotal > 0);
    check("world streams to a healthy size", stats.ready >= 60, `ready=${stats.ready}`);
    check("worker-side meshing happened", stats.meshMsTotal > 0, `meshMsTotal=${stats.meshMsTotal.toFixed(1)}`);
    check("player is grounded", (await page.evaluate(() => window.__voxelM1.getPlayer())).onGround === true);

    // The app must come up on a REAL WebGL1 context (the 2D-atlas GLSL100 path only ever
    // binds a plain `Texture`; rendering on WebGL2/WebGPU would silently use the array path).
    const backend = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return canvas?.getContext("webgl") ? "webgl1" : canvas?.getContext("webgl2") ? "webgl2" : "none";
    });
    check("app runs on a WebGL1 context", backend === "webgl1", `context=${backend}`);

    const shot = await page.screenshot({ encoding: "binary" });
    const { blank, stddev } = detectBlankCanvas(shot, 6);
    check("viewport is not blank", !blank, `stddev=${stddev.toFixed(2)}`);
    check(
      "no console/page errors",
      consoleErrors.length === 0 && pageErrors.length === 0,
      `${consoleErrors.length} console / ${pageErrors.length} page errors`,
    );
  } catch (err) {
    check("LEG 1 completed", false, String(err));
  }
  await page.close();
}

async function runLeg2(browser) {
  log("LEG 2: pinned down-looking view contains 2D-atlas terrain (not sky/blank)");
  // `?look=90,-40` = yaw 90deg, pitch -40deg (looking DOWN at the terrain from spawn); the
  // getCamera hook must echo it back so captures stay reproducible.
  const { page, consoleErrors, pageErrors } = await openApp(
    browser,
    "rendererType=WEB_GL1&workers=1&time=0.25&look=90,-40",
  );

  try {
    await waitForQa(page, (s) => s.ready >= 60);

    const cam = await page.evaluate(() => window.__voxelM1.getCamera());
    check("?look= pins the camera (yaw, pitch)", Math.round(cam.thetaDeg) === 90 && Math.round(cam.phiDeg) === -40, `theta=${cam.thetaDeg.toFixed(1)} phi=${cam.phiDeg.toFixed(1)}`);

    // The app must still be on a REAL WebGL1 context for the 2D-atlas path (see LEG 1).
    const backend = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return canvas?.getContext("webgl") ? "webgl1" : canvas?.getContext("webgl2") ? "webgl2" : "none";
    });
    check("context is still WebGL1 for the 2D-atlas path", backend === "webgl1", `context=${backend}`);

    // Readback must use the COMPOSITED screenshot, not gl.readPixels: this context is created
    // without preserveDrawingBuffer, so the drawing buffer is undefined outside the render frame
    // and readPixels outside the app's rAF loop returns zeros (regression 2026-11-02: the strip
    // always read terrain=0 sky=0 while the screenshot showed textured terrain). Decode the PNG
    // like detectBlankCanvas does and run the same hue classifier on the ground strip.
    const shot = await page.screenshot({ encoding: "binary" });
    const { width, height, data } = PNG.sync.read(Buffer.from(shot));
    // Original strip = canvas row floor(h*0.15) (bottom-origin). Screenshot rows are top-origin,
    // so mirror the index; a 5-row band avoids single-row HUD artifacts.
    const yBase = height - 1 - Math.floor(height * 0.15);
    let terrainLike = 0;
    let skyLike = 0;
    for (let y = yBase - 2; y <= yBase + 2; y++) {
      for (let x = 0; x < width; x += 2) {
        const idx = (width * y + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Terrain tiles are dominantly green (grass) / brown (dirt/wood) with low blue; the sky
        // at noon is high-blue. Classify by hue, not by strict thresholds.
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        if (maxC > 40 && b < maxC - 25 && maxC - minC > 25) terrainLike++;
        else if (b > r + 10 && b > 60) skyLike++;
      }
    }
    const readback = { terrainLike, skyLike, w: width };

    check("terrain-like pixels dominate the ground strip", readback.terrainLike > readback.skyLike && readback.terrainLike > readback.w * 0.2, `terrain=${readback.terrainLike} sky=${readback.skyLike} of ${readback.w}`);
    check(
      "no console/page errors in leg 2",
      consoleErrors.length === 0 && pageErrors.length === 0,
      `${consoleErrors.length} console / ${pageErrors.length} page errors`,
    );
  } catch (err) {
    check("LEG 2 completed", false, String(err));
  }
  await page.close();
}

main().catch((err) => {
  log("GATE CRASH", err);
  process.exit(1);
});
