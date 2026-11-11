---
name: "imagegen-mai"
description: "Generate or edit raster images with Microsoft Foundry MAI-Image models (default MAI-Image-2.6-Flash) when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, posters, or chroma-key cutouts. Use when the agent should create a brand-new image, edit or combine up to five existing images, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Image Generation Skill for Microsoft Foundry MAI-Image

Generates or edits images for the current project (for example website assets, game assets, UI mockups, product mockups, wireframes, logo design, photorealistic images, or infographics) with MAI-Image deployments in Microsoft Foundry.

In this file, `<skill-dir>` means the directory that contains this `SKILL.md`.

## Execution mode and rules

This skill uses the bundled CLI at `<skill-dir>/scripts/image_gen.js`. The agent host does not provide built-in image-generation or image-viewing tools for this workflow, so do not reference or attempt to use nonexistent built-ins.

The CLI exposes three subcommands:

- `generate`
- `edit`
- `generate-batch`

Rules:

- Use `scripts/image_gen.js` for normal image generation and editing requests.
- The CLI supports MAI-Image series models only. Never route GPT Image, DALL-E, or other models through it.
- The default deployment is `IMAGEGEN_MAI_IMAGE_DEPLOYMENT`, or `MAI-Image-2.6-Flash` when unset. Never silently switch to a different deployment. Ask the user first, unless the user has already explicitly requested that model.
- MAI image models always return an opaque PNG. For transparent images, use the chroma-key workflow below and tell the user that the cutout is made locally.
- The word `batch` by itself does not require `generate-batch`. Use `generate-batch` when a multi-asset request is naturally represented as a JSONL batch; otherwise run individual CLI commands.
- Live API calls require MAI credentials and network access.
- Use the bundled `scripts/image_gen.js` workflow. Do not create one-off SDK runners.
- Never modify `scripts/image_gen.js`. If something is missing, ask the user before doing anything else.

Output policy:

- Write generated assets directly to the requested path, or to `output/imagegen/` when the user does not specify a path.
- If the image is meant for the current project, save the final selected image in the workspace before finishing.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

Shared prompt guidance lives in `references/prompting.md` and `references/sample-prompts.md`.

CLI docs/resources:

- `references/cli.md`
- `references/image-api.md`
- `references/codex-network.md`
- `scripts/image_gen.js`

Local post-processing helper:

- `<skill-dir>/scripts/remove_chroma_key.js`: removes a flat chroma-key background from a generated image and writes a PNG with alpha. Prefer auto-key sampling, soft matte, and despill for antialiased edges.

## When to use

- Generate a new image (concept art, product shot, cover, website hero, poster)
- Generate a new image that depends on current real-world information (use `--web-grounding`)
- Edit an existing image (object removal or replacement, attribute changes, inpainting, text updates, lighting or weather changes, artifact cleanup)
- Combine up to five reference images into one result (product, character, or brand-asset consistency)
- Produce many assets or variants for one task

## When not to use

- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap
- Output larger than about 1.5K (the MAI-Image-2.6 cap is 2,359,296 pixels, for example `1536x1536`); tell the user the limit instead of upscaling silently

## Decision tree

Think about two separate questions:

1. **Intent**: is this a new image or an edit of an existing image?
2. **Execution strategy**: is this one asset or many assets/variants?

Intent:

- If the user wants to modify an existing image while preserving parts of it, treat the request as **edit**.
- If the user provides images as references for style, composition, mood, or subject and wants them reflected in the result, use **edit** with those images as references (the MAI generations API does not accept images).
- If the user provides no images, treat the request as **generate**.

Edit semantics:

- CLI edit mode accepts one to five local PNG or JPEG files via repeated `--image` flags.
- If the user provides attached images or references from the conversation, save them locally first if the environment supports that; otherwise ask the user for local file paths.
- Image order is meaningful, so label each image by index and role in the prompt.
- For edits, preserve invariants aggressively and save non-destructively by default.
- `MAI-Image-2` and `MAI-Image-2e` do not support edits.

Execution strategy:

- Use the CLI `generate-batch` subcommand for many prompts/assets when JSONL batching is the clearest workflow.
- The MAI API returns one image per request and has no `n` parameter. For variants, run separate commands or separate batch jobs with distinct `out` names.
- Rate limits are low (for example 6 requests per minute for `MAI-Image-2.6-Flash` at Tier 1). Keep `--concurrency` at the default of 2 unless the user knows their quota.

Assume the user wants a new image unless they clearly ask to change an existing one.

## Workflow

1. Decide the CLI subcommand: `generate`, `edit`, or `generate-batch`.
2. Decide whether the output is preview-only or meant to be consumed by the current project.
3. Decide the execution strategy: single asset vs repeated CLI commands vs CLI `generate-batch`.
4. Collect inputs up front: prompt(s), exact text (verbatim), constraints/avoid list, target size or aspect ratio, and any input images.
5. For every input image, label its role explicitly:
   - reference image
   - edit target
   - supporting insert/style/compositing input
6. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use this skill rather than substituting SVG/HTML/CSS placeholders. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
7. Augment the prompt based on specificity:
   - If the user's prompt is already specific and detailed, normalize it into a clear spec without adding creative requirements.
   - If the user's prompt is generic, add tasteful augmentation only when it materially improves output quality.
8. Choose the size. Use `--size WIDTHxHEIGHT` for a known target, or `--auto-aspect-ratio` (MAI-Image-2.6 family) when the composition should decide. Add `--web-grounding` (MAI-Image-2.6 family) when the prompt depends on current real-world entities, places, or events.
9. Run `scripts/image_gen.js` with the default deployment.
10. For transparent-output requests, follow the chroma-key workflow below.
11. Inspect outputs and validate: subject, style, composition, text accuracy, and invariants/avoid items.
12. Iterate with a single targeted change, then re-check.
13. For preview-only work, write to `output/imagegen/` unless the user asked for a different location.
14. For project-bound work, write the artifact into the workspace and update any consuming code or references.
15. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only. Discarded variants do not need to be kept unless requested.
16. Use the CLI docs for deployment, size, `auto_aspect_ratio`, `web_grounding`, output paths, and network setup.
17. Always report the final saved path(s) for any workspace-bound asset(s), plus the final prompt or prompt set.

## Transparent image requests

MAI image models always return an opaque PNG and have no transparent-background option. Make transparent assets with a chroma-key source image and local removal.

Sequence:

1. Use `scripts/image_gen.js generate` (or `edit` for an existing image) to put the requested subject on a perfectly flat solid chroma-key background.
2. Choose a key color that is unlikely to appear in the subject: default `#00ff00`, use `#ff00ff` for green subjects, and avoid `#0000ff` for blue subjects.
3. Keep the chroma-key source image in the workspace or `tmp/imagegen/`.
4. Run the bundled helper:

   ```bash
   node "<skill-dir>/scripts/remove_chroma_key.js" \
     --input <source> \
     --out <final.png> \
     --auto-key border \
     --soft-matte \
     --transparent-threshold 12 \
     --opaque-threshold 220 \
     --despill
   ```

5. Validate that the output has an alpha channel, transparent corners, plausible subject coverage, and no obvious key-color fringe. Composite it over a light and a dark background to check for halos. If a thin fringe remains, retry once with `--edge-contract 1`; use `--edge-feather 0.25` only when the edge is visibly stair-stepped and the subject is not shiny or reflective.
6. Save the final alpha PNG in the project if the asset is project-bound.

Prompt chroma-key requests like this:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

Chroma keying is a poor fit for hair, fur, feathers, smoke, glass, liquids, translucent materials, reflective objects, and soft shadows. Tell the user about this limit before promising a clean cutout for those subjects.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Treat this as prompt-shaping guidance, not a closed schema. Use only the lines that help, and add a short extra labeled line when it materially improves clarity.

### Specificity policy

Use the user's prompt specificity to decide how much augmentation is appropriate:

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, you may add tasteful augmentation when it will materially improve the result.

Allowed augmentations:

- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:

- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Use-case taxonomy (exact slugs)

Classify each request into one of these buckets and keep the slug consistent across prompts and references.

Generate:

- photorealistic-natural: candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup: product/packaging shots, catalog imagery, merch concepts.
- ui-mockup: app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram: diagrams/infographics with structured layout and text.
- scientific-educational: classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- ads-marketing: campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- productivity-visual: slide, chart, workflow, and data-heavy business visuals.
- logo-brand: logo/mark exploration, vector-friendly.
- illustration-story: comics, children's book art, narrative scenes.
- stylized-concept: style-driven concept art, 3D/stylized renders.
- historical-scene: period-accurate/world-knowledge scenes.

Edit:

- text-localization: translate/replace in-image text, preserve layout.
- identity-preserve: try-on, person-in-scene; lock face/body/pose.
- precise-object-edit: remove/replace a specific element (including interior swaps).
- lighting-weather: time-of-day/season/atmosphere changes only.
- background-extraction: clean cutout via a flat chroma-key background plus local removal with `scripts/remove_chroma_key.js`.
- style-transfer: apply reference style while changing subject/scene.
- compositing: multi-image insert/merge with matched lighting/perspective (up to five images).
- sketch-to-render: drawing/line art to photoreal render.

## Shared prompt schema

Use the following labeled spec as shared prompt scaffolding for both top-level modes:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:

- `Asset type` and `Input images` are prompt scaffolding, not dedicated CLI flags.
- `Scene/backdrop` refers to the visual setting.
- Execution notes such as size, `auto_aspect_ratio`, `web_grounding`, and output paths belong to the CLI path, not the prompt text.

Augmentation rules:

- Keep it short.
- Add only the details needed to improve the prompt materially.
- For edits, explicitly list invariants (`change only X; keep Y unchanged`).
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

## Examples

### Generation example (hero image)

```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

Run with `--size 1920x1216` for a wide hero on the MAI-Image-2.6 family.

### Edit example (invariants)

```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

## Prompting best practices

- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use (ad, UI mock, infographic) to set the mode and polish level.
- Use camera/composition language for photorealism.
- Only use SVG/vector stand-ins when the user explicitly asked for vector output or a non-image placeholder.
- Quote exact text and specify typography + placement. MAI-Image-2.6 models have stronger text rendering; still verify every word.
- For tricky words, spell them letter-by-letter and require verbatim rendering.
- For multi-image inputs, reference images by index and describe how they should be used.
- For edits, repeat invariants every iteration to reduce drift.
- Iterate with single-change follow-ups.
- If the prompt is generic, add only the extra detail that will materially help.
- If the prompt is already detailed, normalize it instead of expanding it.
- See `references/cli.md` and `references/image-api.md` for size, `auto_aspect_ratio`, `web_grounding`, and output-path guidance.

More principles shared by both modes: `references/prompting.md`.
Copy/paste specs shared by both modes: `references/sample-prompts.md`.

## Guidance by asset type

Asset-type templates (website assets, game assets, wireframes, logo) are consolidated in `references/sample-prompts.md`.

## MAI-Image-2.6-Flash CLI guidance

The CLI defaults to `MAI-Image-2.6-Flash`, the faster, lower-cost variant of `MAI-Image-2.6` with the same generation and editing capabilities. `MAI-Image-2.6` is the precision option for complex edits, text-heavy layouts, and final campaign assets; ask before switching to it unless the user requested it.

- There is no `quality`, `n`, `background`, `output_format`, `input_fidelity`, or mask setting. Output is always PNG.
- Width and height must each be at least 768px, and `width x height` must not exceed 2,359,296 on the MAI-Image-2.6 family (1,048,576 on the MAI-Image-2.5 family). There is no documented aspect-ratio limit.
- Size flags apply to generations only; the edits API does not accept `width`/`height`. For edits, describe the framing in the prompt or use `--auto-aspect-ratio`.
- `--auto-aspect-ratio` lets the model pick the aspect ratio from the prompt and input images.
- `--web-grounding` lets the model use Bing Search results as context for current real-world subjects.
- Use `1024x1024` (the default) for fast square drafts.

Popular sizes on the MAI-Image-2.6 family:

- `1024x1024` square (default)
- `1536x1536` largest square
- `1536x1024` landscape, `1024x1536` portrait
- `1920x1216` wide landscape, `1216x1920` tall portrait
- `2048x1152` 16:9 landscape

## CLI mode

### Temp and output conventions

- Use `tmp/imagegen/` for intermediate files (for example JSONL batches or chroma-key sources); delete them when done.
- Write final artifacts under `output/imagegen/`.
- Use `--out` (or `--out-dir` for batches) to control output paths; keep filenames stable and descriptive.

### Dependencies

Run `npm install` in `<skill-dir>` once. The CLI uses Node built-in `fetch` for API calls and `sharp` for `--downscale-max-dim` and chroma-key removal. Node.js 20 or later is required.

If installation is not possible in this environment, tell the user which dependency is missing and how to install it into their active environment.

### Environment

- `IMAGEGEN_MAI_ENDPOINT` must be set to the Foundry resource endpoint, `https://<resource-name>.services.ai.azure.com`. An Azure OpenAI endpoint (`*.openai.azure.com`) does not serve the MAI image API.
- Set `IMAGEGEN_MAI_API_KEY` for key authentication, or `IMAGEGEN_MAI_AUTH_TOKEN` for a Microsoft Entra ID token scoped to `https://cognitiveservices.azure.com/.default`.
- `IMAGEGEN_MAI_IMAGE_DEPLOYMENT` is optional; it supplies the default `--model` value. Otherwise `--model` defaults to `MAI-Image-2.6-Flash`.
- `--model` is the deployment name, not necessarily the base model name. If the deployment has a custom name, set `IMAGEGEN_MAI_BASE_MODEL` or pass `--base-model` so the CLI applies the right limits.
- Never ask the user to paste the full key in chat. Ask them to set it locally and confirm when ready.

If the credentials are missing, give the user these steps:

1. Create or locate a Microsoft Foundry resource in a region that offers MAI image models, and deploy `MAI-Image-2.6-Flash` (Global Standard).
2. Set `IMAGEGEN_MAI_ENDPOINT` and `IMAGEGEN_MAI_API_KEY` (or `IMAGEGEN_MAI_AUTH_TOKEN`) as environment variables.
3. Optionally set `IMAGEGEN_MAI_IMAGE_DEPLOYMENT` and `IMAGEGEN_MAI_BASE_MODEL`.
4. Offer to guide them through setting the environment variables for their OS/shell if needed.

### Script-mode notes

- CLI commands + examples: `references/cli.md`
- API parameter quick reference: `references/image-api.md`
- Network approvals / sandbox settings for CLI mode: `references/codex-network.md`

## Reference map

- `references/prompting.md`: shared prompting principles for both modes.
- `references/sample-prompts.md`: shared copy/paste prompt recipes for both modes.
- `references/cli.md`: CLI usage via `scripts/image_gen.js`.
- `references/image-api.md`: MAI image API parameter reference, limits, and errors.
- `references/codex-network.md`: network/sandbox troubleshooting for CLI mode.
- `scripts/image_gen.js`: CLI implementation.
- `scripts/remove_chroma_key.js`: local post-processing helper for transparent output.
