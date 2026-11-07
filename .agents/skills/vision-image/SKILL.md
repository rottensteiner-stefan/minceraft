---
name: vision-image
description: Provide "synthetic eyes" for text-only models (e.g. Deepseek V4 Flash) by sending an image to an external vision API and returning its description as text. Use whenever you need to see or analyze an image — a render or screenshot, concept art, a reference photo, a texture/tool output, or comparing two visuals — and you cannot otherwise view the file.
---

# Vision Image — "Synthetic Eyes" bridge

This skill exists because the active model (Deepseek V4 Flash) is **text-only**: it cannot
look at image files directly. The bundled script `.agents/skills/vision-image/vision-image.mjs`
sends an image to an external multimodal model (Gemini by default) and prints the returned
description as text, so any non-multimodal agent can "see" the image through text.

## When to use

Invoke this skill whenever a task involves visuals you cannot otherwise inspect:

- Verifying a rendered screenshot, golden capture, or GPU/WebGL/WebGPU probe output
  (e.g. `.agents/scratches/**/*.png`, `showcase_*`, `qa_*`, `goldens/**` screenshots).
- Analyzing concept art, reference photos, mood boards, or generated assets
  (e.g. `.agents/scratches/oil_puddle_concepts/*.jpg`, character model sheets).
- Reading text that is baked into an image (signs, decals, UI screenshots, subtitles/VTT frames).
- Comparing two images (Ist/Soll, before/after, old vs. new baseline).
- Checking an image-based tool's output that you generated but cannot view.

## Requirements

- `GEMINI_API_KEY` must be set in the environment for the default provider.
- `OPENAI_API_KEY` is only needed when explicitly selecting the OpenAI provider.
- Node.js ≥ 18 (script uses global `fetch`).
- Supported image types: **jpg/jpeg, png, webp, gif** only. The script exits with an error
  for anything else.

## Usage

```bash
node .agents/skills/vision-image/vision-image.mjs <image-path> [--prompt "<task>"] [--provider openai|gemini]
```

- `<image-path>` — path to the image (relative paths are resolved from the repo root).
- `--prompt "<task>"` — what the vision model should focus on. Without it, a generic
  technical-detail description is used (composition, content, style, colors, lighting, text).
- `--provider openai|gemini` — default `gemini` (the verified-working bridge; `gpt-4o-mini`
  behind it). `openai` is opt-in.

The script prints **only** the model's text reply to stdout (never the API keys) and exits
non-zero on any failure (missing key, unsupported type, HTTP error) with a short reason on
stderr.

## Prompt discipline

Always pass a focused `--prompt`. Do **not** rely on the default description when you need
something specific. Good prompt templates for this repo's workflows:

- **Render verification** — `Inspect this engine render. Report which object types are
  visible, whether they are lit/material-correct, any rendering artifacts (black spots,
  missing geometry, texturing errors), and the dominant colors/lighting. Reply in English.`

- **Ist/Soll comparison (before/after)** — `Describe this first image (IST, engine output),
  then describe this second image (SOLL, reference target). List concrete visual differences
  in shading, color, material and texture quality, then rate similarity. Reply in English.`
  (When AI wants pixel-accurate directions, prefer targeted numerical prompts instead:
  `Report average RGB and brightness per image region.`)

- **Reading text in an image** — `Transcribe all text visible in this image exactly as shown,
  preserving capitalization and line breaks.`

- **Character/model sheet review** — `Analyze this character turnarounds: pose, equipment
  placement (lantern hand, holster, mask), whether it is flat unshaded albedo with no cast
  shadows, and any text/logos. Reply in English.`

Combine the response with the repo's existing verification loops (golden comparisons, QA
probes) rather than treating the description as ground truth for byte-exact checks — the
vision reply is an interpretation, not a measurement.

## Notes

- The canonical script location is inside this skill folder. Do **not** rely on a copy at
  `.agents/vision-image.mjs` — it has been moved here.
- This is the tool referenced in `.agents/notes/backlog.md` (2026-10-08, "Synthetische
  Augen"): the Gemini provider (`gemini-3.8-flash`) was verified working; the OpenAI key in
  the original shell session reported 401/invalid, so prefer `gemini`.
- If the image is too large or the reply truncates, crop/resize with `sips` first and pass
  the cropped region.
- For continuous visual Q&A, you can run the script per image — it is stateless.
