#!/usr/bin/env node
//
// vision-image.mjs — "synthetic eyes" for text-only models (e.g. Deepseek V4 Flash).
// Sends an image to an external vision API and prints the response as text, so any
// non-multimodal agent can "see" an image through the returned description.
//
// Usage:
//   node .agents/skills/vision-image/vision-image.mjs <image-path> [--prompt "<task>" ] [--provider openai|gemini]
//
// Providers (default: gemini — the verified-working bridge; openai is opt-in via --provider):
//   gemini  -> gemini-3.8-flash     (env GEMINI_API_KEY, default)
//   openai  -> gpt-4o-mini          (env OPENAI_API_KEY, only via --provider openai)
//
// The script never prints secrets; it only prints the model's text reply.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--"));
const promptArg = args.findIndex((a) => a === "--prompt");
const prompt = promptArg >= 0 ? args[promptArg + 1] : "Describe this image in precise technical detail: composition, content, visual style, colors, lighting, and any text visible. Reply in English.";
const provIdx = args.findIndex((a) => a === "--provider");
const provider = provIdx >= 0 ? args[provIdx + 1] : "gemini";

if (!fileArg) {
  console.error("usage: node .agents/skills/vision-image/vision-image.mjs <image-path> [--prompt <task>] [--provider openai|gemini]");
  process.exit(1);
}
if (provider === "openai" && !process.env.OPENAI_API_KEY) {
  console.error("--provider openai set, but OPENAI_API_KEY is missing.");
  process.exit(1);
}
if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing.");
  process.exit(1);
}
if (provider !== "openai" && provider !== "gemini") {
  console.error(`Unknown --provider "${provider}" (openai|gemini).`);
  process.exit(1);
}

const filePath = resolve(fileArg);
statSync(filePath);
const ext = filePath.split(".").pop().toLowerCase();
const mime =
  ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
  ext === "png" ? "image/png" :
  ext === "webp" ? "image/webp" :
  ext === "gif" ? "image/gif" : null;
if (!mime) {
  console.error(`Unsupported image type ".${ext}" (jpg/png/webp/gif expected).`);
  process.exit(1);
}
const dataUrl = `data:${mime};base64,${readFileSync(filePath).toString("base64")}`;

async function openaiVision() {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] },
      ],
      max_tokens: 4096,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openai ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function geminiVision() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mime, data: readFileSync(filePath).toString("base64") } },
            ],
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`gemini ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

const fn = provider === "openai" ? openaiVision : geminiVision;
fn()
  .then((text) => {
    console.log(text.trim());
  })
  .catch((err) => {
    console.error(`vision-image.mjs (${provider}) failed:`, err.message);
    process.exit(1);
  });
