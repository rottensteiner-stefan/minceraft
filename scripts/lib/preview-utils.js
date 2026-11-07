// Shared helpers for the headless Puppeteer gates (`scripts/check-voxel-*.mjs`).
import http from "http";
import { PNG } from "pngjs";

/** Port of the `vite preview` server the scripts spawn and visit. Override via PREVIEW_PORT. */
export const PREVIEW_PORT = Number(process.env.PREVIEW_PORT) || 4173;
export const PREVIEW_ORIGIN = `http://localhost:${PREVIEW_PORT}`;

/** Extra `npm run preview` arguments pinning the server to PREVIEW_PORT. */
export const PREVIEW_ARGS = ["run", "preview", "--", "--port", String(PREVIEW_PORT), "--strictPort"];

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Polls until the server answers any HTTP response.
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Preview server at ${url} did not become ready within ${timeoutMs} ms`);
}

/**
 * Decodes a screenshot PNG buffer and checks whether it looks like a blank/flat canvas: a luminance
 * standard deviation below `stddevThreshold` means nothing was rendered even though no error was
 * thrown. Only the CENTER 50% (both axes) is sampled.
 * @param {Buffer} pngBuffer
 * @param {number} stddevThreshold
 * @returns {{ blank: boolean, stddev: number }}
 */
export function detectBlankCanvas(pngBuffer, stddevThreshold) {
  const { data, width, height } = PNG.sync.read(Buffer.from(pngBuffer));
  const sampleStep = 4;
  const xStart = Math.round(width * 0.25);
  const xEnd = Math.round(width * 0.75);
  const yStart = Math.round(height * 0.25);
  const yEnd = Math.round(height * 0.75);
  const luminances = [];
  let sum = 0;
  for (let y = yStart; y < yEnd; y += sampleStep) {
    for (let x = xStart; x < xEnd; x += sampleStep) {
      const idx = (width * y + x) * 4;
      const luminance = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
      luminances.push(luminance);
      sum += luminance;
    }
  }
  const mean = sum / luminances.length;
  let variance = 0;
  for (const l of luminances) variance += (l - mean) * (l - mean);
  const stddev = Math.sqrt(variance / luminances.length);
  return { blank: stddev < stddevThreshold, stddev };
}
