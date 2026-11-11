# CLI reference (`scripts/image_gen.js`)

This file documents the bundled CLI. Use it for image generation and editing with Microsoft Foundry MAI-Image deployments. The CLI accepts MAI-Image series models only.

`generate-batch` is a CLI subcommand. It is not a top-level mode of the skill. The word `batch` in a user request does not always require `generate-batch`.

## What this CLI does

- `generate`: generate a new image from a prompt (`/mai/v1/images/generations`)
- `edit`: edit or combine one to five existing images (`/mai/v1/images/edits`)
- `generate-batch`: run many generation jobs from a JSONL file

Real API calls require network access and the MAI environment variables. `--dry-run` does not.

## Setup

Set a stable path to the CLI. `<skill-dir>` is the directory that contains `SKILL.md`:

```bash
export IMAGE_GEN="<skill-dir>/scripts/image_gen.js"
```

Install dependencies once in the skill directory with `npm install` (needed for `--downscale-max-dim` and `scripts/remove_chroma_key.js`).

Environment variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `IMAGEGEN_MAI_ENDPOINT` | Yes | Foundry resource endpoint, `https://<resource-name>.services.ai.azure.com`. A trailing `/mai/v1` is accepted; other paths are ignored with a warning. |
| `IMAGEGEN_MAI_API_KEY` | One of these two | API key, sent as the `api-key` header. |
| `IMAGEGEN_MAI_AUTH_TOKEN` | One of these two | Microsoft Entra ID token, sent as `Authorization: Bearer`. Used only when no API key is set. |
| `IMAGEGEN_MAI_IMAGE_DEPLOYMENT` | No | Default deployment name. Falls back to `MAI-Image-2.6-Flash`. |
| `IMAGEGEN_MAI_BASE_MODEL` | No | Base model of a deployment with a custom name, for example `MAI-Image-2.6-Flash`. |

Get an Entra ID token with the Azure CLI:

```bash
export IMAGEGEN_MAI_AUTH_TOKEN="$(az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv)"
```

Tokens expire after about an hour.

## Quick start

Dry-run (no API call, no network, no credentials):

```bash
node "$IMAGE_GEN" generate \
  --prompt "Test" \
  --out output/imagegen/test.png \
  --dry-run
```

Generate:

```bash
node "$IMAGE_GEN" generate \
  --prompt "A cozy alpine cabin at dawn" \
  --size 1536x1024 \
  --out output/imagegen/alpine-cabin.png
```

Edit with two reference images:

```bash
node "$IMAGE_GEN" edit \
  --image product.png \
  --image logo.png \
  --prompt "Image 1: edit target. Image 2: logo. Print the logo from Image 2 on the mug in Image 1; keep everything else unchanged." \
  --out output/imagegen/mug-with-logo.png
```

Let the model choose the aspect ratio and use web grounding (MAI-Image-2.6 family only):

```bash
node "$IMAGE_GEN" generate \
  --prompt "A travel poster for Taipei 101 during the New Year fireworks" \
  --auto-aspect-ratio \
  --web-grounding \
  --out output/imagegen/taipei-poster.png
```

## Guardrails

- Use the bundled CLI directly (`node "$IMAGE_GEN" ...`).
- Do not create one-off runners (for example `gen_images.py`) unless the user explicitly asks for a custom wrapper.
- Never modify `scripts/image_gen.js`. If something is missing, ask the user before doing anything else.
- Do not silently switch to a different deployment than the default; ask first unless the user already explicitly requested that model.
- The CLI refuses non-MAI models. Do not try to route GPT Image or other models through it.

## Defaults

- Deployment: `IMAGEGEN_MAI_IMAGE_DEPLOYMENT`, otherwise `MAI-Image-2.6-Flash`.
- Size: `1024x1024` for generations. With `--auto-aspect-ratio` and no size, the CLI sends no `width`/`height`.
- Output: PNG at `output/imagegen/output.png`. Existing files are not overwritten without `--force`.
- Retries: up to 3 attempts for `429`, `5xx`, and network errors, honoring `Retry-After`.
- Prompt augmentation: on. The CLI wraps the prompt as `Primary request: ...` plus any labeled fields. Use `--no-augment` to send the prompt verbatim.

## Model selection

The CLI validates each request against the base model's rules:

| Base model | Edits | Max `width x height` | `--auto-aspect-ratio` / `--web-grounding` |
| --- | --- | --- | --- |
| `MAI-Image-2.6-Flash`, `MAI-Image-2.6` | Yes | 2,359,296 | Yes |
| `MAI-Image-2.5-Pro`, `MAI-Image-2.5-Flash`, `MAI-Image-2.5` | Yes | 1,048,576 | No |
| `MAI-Image-2`, `MAI-Image-2e` | No | 1,048,576 | No |

In Microsoft Foundry, `--model` is the deployment name, which does not have to match the base model name. The CLI matches the deployment name against the table above without regard to case. If the deployment has a custom name (for example `prod-flash`), pass `--base-model MAI-Image-2.6-Flash` or set `IMAGEGEN_MAI_BASE_MODEL`. Otherwise the CLI refuses the request.

## Size guidance

- `width` and `height` must each be at least 768px.
- There is no documented aspect-ratio limit or multiple-of-16 rule; only the pixel cap applies.
- Use `--size WIDTHxHEIGHT` or `--width N --height N` (not both). Width and height must be set together.
- Size flags are for `generate` and `generate-batch` only. The edits API does not accept them.

Popular sizes on the MAI-Image-2.6 family:

- `1024x1024`: square draft (default)
- `1536x1536`: largest square
- `1536x1024` / `1024x1536`: 3:2 landscape / portrait
- `1920x1216` / `1216x1920`: wide landscape / tall portrait (about 16:10)
- `2048x1152`: 16:9 landscape (2,359,296 pixels, exactly at the cap)

On the MAI-Image-2.5 family, stay at or below 1,048,576 pixels: `1024x1024`, `1280x768`, `768x1280`.

## Options

Shared options:

| Option | Meaning |
| --- | --- |
| `--model DEPLOYMENT` | Deployment name |
| `--base-model MODEL` | Base MAI-Image model for a custom deployment name |
| `--prompt TEXT` / `--prompt-file PATH` | Prompt text (one of the two) |
| `--auto-aspect-ratio` / `--no-auto-aspect-ratio` | Send `auto_aspect_ratio` true/false (MAI-Image-2.6 family) |
| `--web-grounding` / `--no-web-grounding` | Send `web_grounding` true/false (MAI-Image-2.6 family) |
| `--out PATH` | Output PNG path; a missing extension becomes `.png`; an existing directory gets `output.png` |
| `--force` | Overwrite existing outputs |
| `--dry-run` | Print the request and output path without calling the API |
| `--max-attempts N` | Attempts for transient errors, 1-10 (default 3) |
| `--augment` / `--no-augment` | Turn prompt augmentation on or off |
| `--use-case`, `--scene`, `--subject`, `--style`, `--composition`, `--lighting`, `--palette`, `--materials`, `--text`, `--constraints`, `--negative` | Labeled prompt augmentation fields |
| `--downscale-max-dim N` | Also write a smaller PNG copy whose long edge is at most N |
| `--downscale-suffix SUFFIX` | Suffix for the smaller copy (default `-web`) |

`generate` and `generate-batch` only:

| Option | Meaning |
| --- | --- |
| `--width N` / `--height N` | Output size in pixels |
| `--size WIDTHxHEIGHT` | Shorthand for `--width` and `--height` |

`edit` only:

| Option | Meaning |
| --- | --- |
| `--image PATH` | PNG or JPEG input; repeat up to five times. Order matters; label each image by index in the prompt. |

`generate-batch` only:

| Option | Meaning |
| --- | --- |
| `--input PATH` | JSONL jobs file (required) |
| `--out-dir DIR` | Output directory (required) |
| `--concurrency N` | Parallel requests, 1-10 (default 2) |
| `--fail-fast` | Stop starting new jobs after the first failure |

## JSONL batch format

Each non-empty line that does not start with `#` is one job, either a plain prompt string or a JSON object with a `prompt`. At most 500 jobs.

```jsonl
{"prompt":"Cavernous hangar interior with a compact shuttle parked near the center","use_case":"stylized-concept","composition":"wide-angle, low-angle","size":"1536x1024","out":"hangar.png"}
{"prompt":"Gray wolf in profile in a snowy forest","fields":{"use_case":"photorealistic-natural","constraints":"no watermark"},"width":1024,"height":1024}
{"prompt":"Current skyline of Taipei at dusk","auto_aspect_ratio":true,"web_grounding":true}
Plain prompt line
```

Job keys:

| Key | Meaning |
| --- | --- |
| `prompt` | Required prompt text |
| `model` | Deployment for this job; when set, the CLI-level `--base-model` no longer applies |
| `base_model` | Base model for a custom deployment name |
| `width`, `height`, `size` | Size for this job; any of them replaces the CLI-level size |
| `auto_aspect_ratio`, `web_grounding` | Booleans (MAI-Image-2.6 family only) |
| `out` | Output file name inside `--out-dir` (directories are dropped); default `NNN-<prompt-slug>.png` |
| `use_case`, `scene`, `subject`, `style`, `composition`, `lighting`, `palette`, `materials`, `text`, `constraints`, `negative` | Prompt augmentation fields |
| `fields` | Object with the same augmentation fields; top-level keys win |

The CLI validates every job and checks for duplicate or existing outputs before it sends the first request.

```bash
node "$IMAGE_GEN" generate-batch \
  --input tmp/imagegen/prompts.jsonl \
  --out-dir output/imagegen/batch
```

## Transparent output

MAI image models always return an opaque PNG. For transparent assets, generate the subject on a flat chroma-key background and remove it locally:

```bash
node "$IMAGE_GEN" generate \
  --prompt "A ceramic coffee mug on a perfectly flat solid #00ff00 chroma-key background; no shadow, no reflection, no gradient; do not use #00ff00 in the mug" \
  --out tmp/imagegen/mug-key.png

node "<skill-dir>/scripts/remove_chroma_key.js" \
  --input tmp/imagegen/mug-key.png \
  --out output/imagegen/mug.png \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

## Not supported

These GPT Image options do not exist in the MAI image API, and the CLI rejects them as unrecognized arguments: `--n`, `--quality`, `--background`, `--output-format`, `--output-compression`, `--moderation`, `--input-fidelity`, `--mask`. For several variants of one prompt, run separate commands or batch jobs with distinct `out` names.
