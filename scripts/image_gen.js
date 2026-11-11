#!/usr/bin/env node
// Image generation CLI for Microsoft Foundry MAI-Image series deployments.
// API reference: Microsoft Learn "Deploy and use MAI image models in Microsoft Foundry"
// (https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image).
import fs from "node:fs";
import path from "node:path";
import { Blob } from "node:buffer";

const DEFAULT_DEPLOYMENT = "MAI-Image-2.6-Flash";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DOWNSCALE_SUFFIX = "-web";
const DEFAULT_OUTPUT_PATH = "output/imagegen/output.png";
const GENERATIONS_ROUTE = "/mai/v1/images/generations";
const EDITS_ROUTE = "/mai/v1/images/edits";
const MAX_BATCH_JOBS = 500;
const MAX_EDIT_IMAGES = 5;
// Both width and height must be at least 768px; the cap is on width x height, not on each edge.
const MIN_EDGE = 768;
const MAI_2_6_MAX_PIXELS = 2_359_296; // 1536x1536 equivalent
const MAI_2_5_MAX_PIXELS = 1_048_576; // 1024x1024 equivalent

// Known MAI-Image models. Keys are lowercase base model names.
// - editsSupported: whether the /images/edits API is available for the model.
// - extras: whether auto_aspect_ratio and web_grounding are accepted (MAI-Image-2.6 family only).
// MAI-Image-2 and MAI-Image-2e are the earlier text-to-image-only models; they share the 2.5 pixel cap.
const MAI_MODELS = new Map([
  ["mai-image-2.6-flash", { name: "MAI-Image-2.6-Flash", maxPixels: MAI_2_6_MAX_PIXELS, editsSupported: true, extras: true }],
  ["mai-image-2.6", { name: "MAI-Image-2.6", maxPixels: MAI_2_6_MAX_PIXELS, editsSupported: true, extras: true }],
  ["mai-image-2.5-pro", { name: "MAI-Image-2.5-Pro", maxPixels: MAI_2_5_MAX_PIXELS, editsSupported: true, extras: false }],
  ["mai-image-2.5-flash", { name: "MAI-Image-2.5-Flash", maxPixels: MAI_2_5_MAX_PIXELS, editsSupported: true, extras: false }],
  ["mai-image-2.5", { name: "MAI-Image-2.5", maxPixels: MAI_2_5_MAX_PIXELS, editsSupported: true, extras: false }],
  ["mai-image-2e", { name: "MAI-Image-2e", maxPixels: MAI_2_5_MAX_PIXELS, editsSupported: false, extras: false }],
  ["mai-image-2", { name: "MAI-Image-2", maxPixels: MAI_2_5_MAX_PIXELS, editsSupported: false, extras: false }],
]);

const AUGMENT_FIELDS = [
  "use_case", "scene", "subject", "style", "composition", "lighting",
  "palette", "materials", "text", "constraints", "negative",
];

function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function warn(message) {
  console.error(`Warning: ${message}`);
}

function parseInteger(value, label) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  die(`${label} must be an integer`);
}

function parseBoolean(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  die(`${label} must be true or false`);
}

// ---------------------------------------------------------------------------
// Model resolution: this CLI supports MAI-Image series deployments only.
// ---------------------------------------------------------------------------

function defaultDeployment() {
  return process.env.IMAGEGEN_MAI_IMAGE_DEPLOYMENT || DEFAULT_DEPLOYMENT;
}

function defaultBaseModel() {
  return process.env.IMAGEGEN_MAI_BASE_MODEL || undefined;
}

function lookupModel(name) {
  if (!name) return null;
  return MAI_MODELS.get(String(name).trim().toLowerCase()) || null;
}

function supportedModelList() {
  return [...MAI_MODELS.values()].map((m) => m.name).join(", ");
}

// A Foundry deployment name does not have to equal the base model name, so a custom
// deployment name needs --base-model (or IMAGEGEN_MAI_BASE_MODEL) to pick the validation rules.
function resolveModel(deployment, baseModel) {
  if (!deployment || !String(deployment).trim()) die("model must be a MAI-Image deployment name.");
  if (baseModel) {
    const spec = lookupModel(baseModel);
    if (!spec) die(`base model ${baseModel} is not a supported MAI-Image model. Supported: ${supportedModelList()}.`);
    return { deployment: String(deployment).trim(), ...spec };
  }
  const spec = lookupModel(deployment);
  if (!spec) {
    die(`deployment ${deployment} is not a known MAI-Image model name. This CLI supports MAI-Image series models only (${supportedModelList()}). If the deployment uses a custom name, pass --base-model <MAI-Image model> or set IMAGEGEN_MAI_BASE_MODEL.`);
  }
  return { deployment: String(deployment).trim(), ...spec };
}

// ---------------------------------------------------------------------------
// Environment and endpoint
// ---------------------------------------------------------------------------

function authMode() {
  if (process.env.IMAGEGEN_MAI_API_KEY) return "api-key";
  if (process.env.IMAGEGEN_MAI_AUTH_TOKEN) return "bearer";
  return null;
}

function ensureCredentials(dryRun) {
  const missing = [];
  if (!process.env.IMAGEGEN_MAI_ENDPOINT) missing.push("IMAGEGEN_MAI_ENDPOINT");
  if (!authMode()) missing.push("IMAGEGEN_MAI_API_KEY (or IMAGEGEN_MAI_AUTH_TOKEN)");
  if (missing.length === 0) {
    console.error(`MAI environment is set (auth: ${authMode()}).`);
    return;
  }
  if (dryRun) {
    warn(`${missing.join(", ")} not set; dry-run only.`);
    return;
  }
  die(`${missing.join(", ")} not set. Export them before running.`);
}

// The MAI image API lives at https://<resource>.services.ai.azure.com/mai/v1/...
// Accept a resource URL with or without a trailing /mai/v1 and drop any other path.
let cachedBaseUrl = null;

function maiBaseUrl() {
  if (cachedBaseUrl) return cachedBaseUrl;
  const raw = process.env.IMAGEGEN_MAI_ENDPOINT.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    die(`IMAGEGEN_MAI_ENDPOINT is not a valid URL: ${raw}`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== "/mai/v1") {
    warn(`IMAGEGEN_MAI_ENDPOINT path ${pathname} is ignored; only the resource host is used (${url.origin}).`);
  }
  if (url.hostname.endsWith(".openai.azure.com")) {
    warn("IMAGEGEN_MAI_ENDPOINT looks like an Azure OpenAI endpoint; MAI image models use https://<resource>.services.ai.azure.com.");
  }
  cachedBaseUrl = url.origin;
  return cachedBaseUrl;
}

function authHeaders() {
  if (process.env.IMAGEGEN_MAI_API_KEY) return { "api-key": process.env.IMAGEGEN_MAI_API_KEY };
  return { Authorization: `Bearer ${process.env.IMAGEGEN_MAI_AUTH_TOKEN}` };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function readPrompt(prompt, promptFile) {
  if (prompt && promptFile) die("Use --prompt or --prompt-file, not both.");
  if (promptFile) {
    if (!fs.existsSync(promptFile)) die(`Prompt file not found: ${promptFile}`);
    const text = fs.readFileSync(promptFile, "utf8").trim();
    if (!text) die(`Prompt file is empty: ${promptFile}`);
    return text;
  }
  if (prompt && prompt.trim()) return prompt.trim();
  die("Missing prompt. Use --prompt or --prompt-file.");
}

function parseSize(size) {
  const match = String(size).trim().match(/^([1-9][0-9]*)x([1-9][0-9]*)$/i);
  if (!match) die("size must be WIDTHxHEIGHT, for example 1024x1024.");
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

// Returns { width, height } to send, or {} when the request should let the model decide.
function resolveDimensions({ width, height, size, autoAspectRatio }, spec, label = "") {
  let w = width === undefined || width === null ? undefined : parseInteger(width, `${label}width`);
  let h = height === undefined || height === null ? undefined : parseInteger(height, `${label}height`);
  if (size !== undefined && size !== null) {
    if (w !== undefined || h !== undefined) die(`${label}use size or width/height, not both.`);
    [w, h] = parseSize(size);
  }
  if (w === undefined && h === undefined) {
    // With auto_aspect_ratio the model picks the aspect ratio, so do not pin a size.
    if (autoAspectRatio) return {};
    w = DEFAULT_WIDTH;
    h = DEFAULT_HEIGHT;
  } else if (w === undefined || h === undefined) {
    die(`${label}width and height must be set together.`);
  } else if (autoAspectRatio) {
    warn(`${label}auto_aspect_ratio is enabled; the model may choose a different aspect ratio than ${w}x${h}.`);
  }
  if (w < MIN_EDGE || h < MIN_EDGE) die(`${label}width and height must each be at least ${MIN_EDGE}px (got ${w}x${h}).`);
  if (w * h > spec.maxPixels) {
    die(`${label}${spec.name} width x height must not exceed ${spec.maxPixels.toLocaleString("en-US")} pixels (got ${w}x${h} = ${(w * h).toLocaleString("en-US")}).`);
  }
  return { width: w, height: h };
}

function validateExtras({ autoAspectRatio, webGrounding }, spec, label = "") {
  if (spec.extras) return;
  const used = [];
  if (autoAspectRatio !== undefined) used.push("auto_aspect_ratio");
  if (webGrounding !== undefined) used.push("web_grounding");
  if (used.length) die(`${label}${used.join(" and ")} apply only to MAI-Image-2.6 and MAI-Image-2.6-Flash, not ${spec.name}.`);
}

function detectImageType(filePath) {
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(8);
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  return null;
}

function checkImagePaths(paths) {
  if (!paths || paths.length === 0) die("edit requires at least one --image.");
  if (paths.length > MAX_EDIT_IMAGES) die(`edit accepts at most ${MAX_EDIT_IMAGES} --image files (got ${paths.length}).`);
  return paths.map((raw) => {
    if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) die(`Image file not found: ${raw}`);
    const type = detectImageType(raw);
    if (!type) die(`Image must be a PNG or JPEG file: ${raw}`);
    return { path: raw, type };
  });
}

// ---------------------------------------------------------------------------
// Prompt augmentation
// ---------------------------------------------------------------------------

function fieldsFromArgs(args) {
  return {
    use_case: args.useCase,
    scene: args.scene,
    subject: args.subject,
    style: args.style,
    composition: args.composition,
    lighting: args.lighting,
    palette: args.palette,
    materials: args.materials,
    text: args.text,
    constraints: args.constraints,
    negative: args.negative,
  };
}

function augmentPromptFields(augment, prompt, fields) {
  if (!augment) return prompt;
  const sections = [];
  if (fields.use_case) sections.push(`Use case: ${fields.use_case}`);
  sections.push(`Primary request: ${prompt}`);
  if (fields.scene) sections.push(`Scene/backdrop: ${fields.scene}`);
  if (fields.subject) sections.push(`Subject: ${fields.subject}`);
  if (fields.style) sections.push(`Style/medium: ${fields.style}`);
  if (fields.composition) sections.push(`Composition/framing: ${fields.composition}`);
  if (fields.lighting) sections.push(`Lighting/mood: ${fields.lighting}`);
  if (fields.palette) sections.push(`Color palette: ${fields.palette}`);
  if (fields.materials) sections.push(`Materials/textures: ${fields.materials}`);
  if (fields.text) sections.push(`Text (verbatim): "${fields.text}"`);
  if (fields.constraints) sections.push(`Constraints: ${fields.constraints}`);
  if (fields.negative) sections.push(`Avoid: ${fields.negative}`);
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Output paths and writing
// ---------------------------------------------------------------------------

function withPngExtension(outPath) {
  const ext = path.extname(outPath);
  if (!ext) return `${outPath}.png`;
  if (ext.toLowerCase() !== ".png") warn(`MAI image APIs always return PNG; output extension ${ext} does not match.`);
  return outPath;
}

function buildOutputPath(out) {
  if (fs.existsSync(out) && fs.statSync(out).isDirectory()) return path.join(out, "output.png");
  return withPngExtension(out);
}

function deriveDownscalePath(filePath, suffix) {
  let value = suffix;
  if (value && !value.startsWith("-") && !value.startsWith("_")) value = `-${value}`;
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${value}${parsed.ext}`);
}

function ensureWritable(outPath, force) {
  if (fs.existsSync(outPath) && !force) die(`Output already exists: ${outPath} (use --force to overwrite)`);
}

async function downscaleImageBytes(imageBytes, maxDim) {
  const { default: sharp } = await import("sharp").catch((error) => {
    if (error && error.code === "ERR_MODULE_NOT_FOUND") die("Downscaling requires sharp. Run `npm install` in this repo first.");
    throw error;
  });
  const metadata = await sharp(imageBytes).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const scale = Math.min(1.0, maxDim / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  let image = sharp(imageBytes);
  if (targetWidth !== width || targetHeight !== height) {
    image = image.resize(targetWidth, targetHeight, { kernel: sharp.kernel.lanczos3 });
  }
  return image.png().toBuffer();
}

function extractImage(result) {
  const item = Array.isArray(result?.data) ? result.data.find((entry) => entry && entry.b64_json) : null;
  if (!item) {
    const preview = JSON.stringify(result).slice(0, 500);
    throw new Error(`Unexpected response format (no data[].b64_json): ${preview}`);
  }
  return item.b64_json;
}

async function writeOutput(imageB64, outPath, { force, downscaleMaxDim, downscaleSuffix }) {
  ensureWritable(outPath, force);
  fs.mkdirSync(path.dirname(outPath) || ".", { recursive: true });
  const raw = Buffer.from(imageB64, "base64");
  fs.writeFileSync(outPath, raw);
  console.log(`Wrote ${outPath}`);
  if (downscaleMaxDim === undefined || downscaleMaxDim === null) return;
  const derived = deriveDownscalePath(outPath, downscaleSuffix);
  ensureWritable(derived, force);
  fs.writeFileSync(derived, await downscaleImageBytes(raw, downscaleMaxDim));
  console.log(`Wrote ${derived}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function isTransientError(error) {
  if (error.status === 429 || (error.status >= 500 && error.status <= 599)) return true;
  const name = error.name?.toLowerCase() || "";
  const message = String(error.message || error).toLowerCase();
  return name.includes("timeout") || message.includes("timed out") || message.includes("econnreset")
    || message.includes("connection reset") || message.includes("fetch failed");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maiFetch(route, options) {
  const response = await fetch(`${maiBaseUrl()}${route}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`${response.status} ${response.statusText}: ${text}`);
    error.status = response.status;
    const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
    if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
    throw error;
  }
  return response.json();
}

async function withRetries(call, { attempts, label }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransientError(error) || attempt >= attempts) throw error;
      const sleepSeconds = error.retryAfter ?? Math.min(60.0, 2.0 ** attempt);
      console.error(`${label} attempt ${attempt}/${attempts} failed (${error.status ?? error.name ?? "Error"}); retrying in ${sleepSeconds.toFixed(1)}s`);
      await sleep(sleepSeconds * 1000);
    }
  }
}

function callGenerate(payload) {
  return maiFetch(GENERATIONS_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function callEdit(payload, images) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  for (const image of images) {
    form.append("image", new Blob([fs.readFileSync(image.path)], { type: image.type }), path.basename(image.path));
  }
  return maiFetch(EDITS_ROUTE, { method: "POST", body: form });
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== null && value !== undefined));
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForJson(value[key])]));
  }
  return value;
}

function printRequest(request) {
  console.log(JSON.stringify(sortForJson(request), null, 2));
}

function buildGeneratePayload(options, label = "") {
  const spec = resolveModel(options.model, options.baseModel);
  const autoAspectRatio = parseBoolean(options.autoAspectRatio, `${label}auto_aspect_ratio`);
  const webGrounding = parseBoolean(options.webGrounding, `${label}web_grounding`);
  validateExtras({ autoAspectRatio, webGrounding }, spec, label);
  const dims = resolveDimensions({ ...options, autoAspectRatio }, spec, label);
  const payload = compact({
    model: spec.deployment,
    prompt: options.prompt,
    ...dims,
    auto_aspect_ratio: autoAspectRatio,
    web_grounding: webGrounding,
  });
  return { spec, payload };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function generate(args) {
  const prompt = augmentPromptFields(args.augment, readPrompt(args.prompt, args.promptFile), fieldsFromArgs(args));
  const { spec, payload } = buildGeneratePayload({ ...args, prompt });
  const outPath = buildOutputPath(args.out);
  const downscaled = args.downscaleMaxDim === undefined ? null : deriveDownscalePath(outPath, args.downscaleSuffix);
  if (args.dryRun) {
    printRequest({ endpoint: GENERATIONS_ROUTE, base_model: spec.name, output: outPath, output_downscaled: downscaled, ...payload });
    return;
  }
  ensureWritable(outPath, args.force);
  console.error(`Calling MAI image generations API (${spec.deployment}, base model ${spec.name}).`);
  const started = Date.now();
  const result = await withRetries(() => callGenerate(payload), { attempts: args.maxAttempts, label: "[generate]" });
  console.error(`Generation completed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  await writeOutput(extractImage(result), outPath, args);
}

async function edit(args) {
  const prompt = augmentPromptFields(args.augment, readPrompt(args.prompt, args.promptFile), fieldsFromArgs(args));
  const spec = resolveModel(args.model, args.baseModel);
  if (!spec.editsSupported) die(`${spec.name} supports text-to-image generation only; image edits are not available.`);
  if (args.width !== undefined || args.height !== undefined || args.size !== undefined) {
    die("width/height/size apply to the image generations API only; the MAI image edits API does not accept them.");
  }
  const autoAspectRatio = parseBoolean(args.autoAspectRatio, "auto_aspect_ratio");
  const webGrounding = parseBoolean(args.webGrounding, "web_grounding");
  validateExtras({ autoAspectRatio, webGrounding }, spec);
  const images = checkImagePaths(args.image);
  const payload = compact({
    model: spec.deployment,
    prompt,
    auto_aspect_ratio: autoAspectRatio,
    web_grounding: webGrounding,
  });
  const outPath = buildOutputPath(args.out);
  const downscaled = args.downscaleMaxDim === undefined ? null : deriveDownscalePath(outPath, args.downscaleSuffix);
  if (args.dryRun) {
    printRequest({
      endpoint: EDITS_ROUTE,
      base_model: spec.name,
      output: outPath,
      output_downscaled: downscaled,
      ...payload,
      image: images.map((image) => `${image.path} (${image.type})`),
    });
    return;
  }
  ensureWritable(outPath, args.force);
  console.error(`Calling MAI image edits API (${spec.deployment}, base model ${spec.name}, ${images.length} image(s)).`);
  const started = Date.now();
  const result = await withRetries(() => callEdit(payload, images), { attempts: args.maxAttempts, label: "[edit]" });
  console.error(`Edit completed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  await writeOutput(extractImage(result), outPath, args);
}

function slugify(value) {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return slug ? slug.slice(0, 60) : "job";
}

function normalizeJob(job, lineNo) {
  if (typeof job === "string") {
    const prompt = job.trim();
    if (!prompt) die(`Empty prompt on line ${lineNo}`);
    return { prompt };
  }
  if (job && typeof job === "object" && !Array.isArray(job)) {
    if (!("prompt" in job) || !String(job.prompt).trim()) die(`Missing prompt on line ${lineNo}`);
    return job;
  }
  die(`Invalid job on line ${lineNo}: expected a string or an object.`);
}

function readJobsJsonl(filePath) {
  if (!fs.existsSync(filePath)) die(`Input file not found: ${filePath}`);
  const jobs = [];
  fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let item = line;
    if (line.startsWith("{")) {
      try {
        item = JSON.parse(line);
      } catch (error) {
        die(`Invalid JSON on line ${index + 1}: ${error.message}`);
      }
    }
    jobs.push(normalizeJob(item, index + 1));
  });
  if (jobs.length === 0) die("No jobs found in input file.");
  if (jobs.length > MAX_BATCH_JOBS) die(`Too many jobs (${jobs.length}). Max is ${MAX_BATCH_JOBS}.`);
  return jobs;
}

function mergeDefined(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function jobOutputPath(outDir, idx, prompt, explicitOut) {
  if (explicitOut) return path.join(outDir, path.basename(withPngExtension(String(explicitOut))));
  return path.join(outDir, `${String(idx).padStart(3, "0")}-${slugify(prompt.slice(0, 80))}.png`);
}

// Resolve every job up front so validation errors surface before any API call is made.
function planBatch(args) {
  const jobs = readJobsJsonl(args.input);
  const baseFields = fieldsFromArgs(args);
  const seen = new Map();
  return jobs.map((job, index) => {
    const i = index + 1;
    const label = `job ${i}: `;
    const prompt = String(job.prompt).trim();
    let fields = mergeDefined(baseFields, job.fields || {});
    fields = mergeDefined(fields, Object.fromEntries(AUGMENT_FIELDS.map((key) => [key, job[key]])));
    // A job-level model switches deployments, so the CLI-level --base-model only carries over when the job keeps the CLI model.
    const jobOptions = {
      model: job.model ?? args.model,
      baseModel: job.base_model ?? (job.model ? undefined : args.baseModel),
      prompt: augmentPromptFields(args.augment, prompt, fields),
    };
    const hasJobDims = ["width", "height", "size"].some((key) => job[key] !== undefined && job[key] !== null);
    Object.assign(jobOptions, hasJobDims
      ? { width: job.width, height: job.height, size: job.size }
      : { width: args.width, height: args.height, size: args.size });
    jobOptions.autoAspectRatio = job.auto_aspect_ratio ?? args.autoAspectRatio;
    jobOptions.webGrounding = job.web_grounding ?? args.webGrounding;
    const { spec, payload } = buildGeneratePayload(jobOptions, label);
    const outPath = jobOutputPath(args.outDir, i, prompt, job.out);
    if (seen.has(outPath)) die(`${label}output ${outPath} is also used by job ${seen.get(outPath)}.`);
    seen.set(outPath, i);
    const downscaled = args.downscaleMaxDim === undefined ? null : deriveDownscalePath(outPath, args.downscaleSuffix);
    return { index: i, spec, payload, outPath, downscaled };
  });
}

async function generateBatch(args) {
  const plan = planBatch(args);
  if (args.dryRun) {
    for (const job of plan) {
      printRequest({ endpoint: GENERATIONS_ROUTE, job: job.index, base_model: job.spec.name, output: job.outPath, output_downscaled: job.downscaled, ...job.payload });
    }
    return;
  }
  for (const job of plan) ensureWritable(job.outPath, args.force);
  fs.mkdirSync(args.outDir, { recursive: true });
  let cursor = 0;
  let failed = 0;
  let stop = false;
  async function worker() {
    while (!stop && cursor < plan.length) {
      const job = plan[cursor++];
      const label = `[job ${job.index}/${plan.length}]`;
      try {
        console.error(`${label} starting (${job.spec.deployment})`);
        const started = Date.now();
        const result = await withRetries(() => callGenerate(job.payload), { attempts: args.maxAttempts, label });
        console.error(`${label} completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        await writeOutput(extractImage(result), job.outPath, args);
      } catch (error) {
        failed += 1;
        console.error(`${label} failed: ${error.message || error}`);
        if (args.failFast) stop = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, plan.length) }, () => worker()));
  if (failed) die(`${failed} of ${plan.length} job(s) failed.`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = {
  "--model": "model",
  "--base-model": "baseModel",
  "--prompt": "prompt",
  "--prompt-file": "promptFile",
  "--size": "size",
  "--out": "out",
  "--use-case": "useCase",
  "--scene": "scene",
  "--subject": "subject",
  "--style": "style",
  "--composition": "composition",
  "--lighting": "lighting",
  "--palette": "palette",
  "--materials": "materials",
  "--text": "text",
  "--constraints": "constraints",
  "--negative": "negative",
  "--downscale-suffix": "downscaleSuffix",
};

const INTEGER_FLAGS = {
  "--width": "width",
  "--height": "height",
  "--max-attempts": "maxAttempts",
  "--downscale-max-dim": "downscaleMaxDim",
};

const SWITCH_FLAGS = {
  "--force": ["force", true],
  "--dry-run": ["dryRun", true],
  "--augment": ["augment", true],
  "--no-augment": ["augment", false],
  "--auto-aspect-ratio": ["autoAspectRatio", true],
  "--no-auto-aspect-ratio": ["autoAspectRatio", false],
  "--web-grounding": ["webGrounding", true],
  "--no-web-grounding": ["webGrounding", false],
};

function parseArgs(argv) {
  if (argv.length === 0 || ["-h", "--help"].includes(argv[0])) {
    printHelp();
    process.exit(0);
  }
  const command = argv[0];
  if (!["generate", "generate-batch", "edit"].includes(command)) die(`invalid choice: ${command}`);
  const args = {
    command,
    model: defaultDeployment(),
    baseModel: defaultBaseModel(),
    out: DEFAULT_OUTPUT_PATH,
    force: false,
    dryRun: false,
    augment: true,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    downscaleSuffix: DEFAULT_DOWNSCALE_SUFFIX,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`${token} requires a value`);
      return argv[++i];
    };
    if (["-h", "--help"].includes(token)) {
      printHelp(command);
      process.exit(0);
    }
    if (token in VALUE_FLAGS) args[VALUE_FLAGS[token]] = next();
    else if (token in INTEGER_FLAGS) args[INTEGER_FLAGS[token]] = parseInteger(next(), token);
    else if (token in SWITCH_FLAGS) args[SWITCH_FLAGS[token][0]] = SWITCH_FLAGS[token][1];
    else if (command === "generate-batch" && token === "--input") args.input = next();
    else if (command === "generate-batch" && token === "--out-dir") args.outDir = next();
    else if (command === "generate-batch" && token === "--concurrency") args.concurrency = parseInteger(next(), token);
    else if (command === "generate-batch" && token === "--fail-fast") args.failFast = true;
    else if (command === "edit" && token === "--image") (args.image ||= []).push(next());
    else die(`unrecognized argument for ${command}: ${token}`);
  }
  if (command === "generate-batch") {
    args.concurrency ??= DEFAULT_CONCURRENCY;
    if (!args.input) die("generate-batch requires --input");
    if (!args.outDir) die("generate-batch requires --out-dir");
  }
  if (command === "edit" && (!args.image || args.image.length === 0)) die("edit requires --image");
  return args;
}

function validateTopLevel(args) {
  if (args.concurrency !== undefined && (args.concurrency < 1 || args.concurrency > 10)) die("--concurrency must be between 1 and 10");
  if (args.maxAttempts < 1 || args.maxAttempts > 10) die("--max-attempts must be between 1 and 10");
  if (args.downscaleMaxDim !== undefined && args.downscaleMaxDim < 1) die("--downscale-max-dim must be >= 1");
  ensureCredentials(args.dryRun);
}

function printHelp(command = null) {
  const shared = `shared options:
  --model DEPLOYMENT          MAI-Image deployment name (default: $IMAGEGEN_MAI_IMAGE_DEPLOYMENT or ${DEFAULT_DEPLOYMENT})
  --base-model MODEL          base MAI-Image model when the deployment name is custom
                              (default: $IMAGEGEN_MAI_BASE_MODEL)
  --prompt PROMPT | --prompt-file PATH
  --auto-aspect-ratio | --no-auto-aspect-ratio   (MAI-Image-2.6 family only)
  --web-grounding | --no-web-grounding           (MAI-Image-2.6 family only)
  --out PATH                  output PNG path (default: ${DEFAULT_OUTPUT_PATH})
  --force                     overwrite existing outputs
  --dry-run                   print the request without calling the API
  --max-attempts N            retries for 429/5xx/network errors (default: ${DEFAULT_MAX_ATTEMPTS})
  --augment | --no-augment
  --use-case VALUE --scene VALUE --subject VALUE --style VALUE
  --composition VALUE --lighting VALUE --palette VALUE --materials VALUE
  --text VALUE --constraints VALUE --negative VALUE
  --downscale-max-dim N --downscale-suffix SUFFIX`;
  const size = `size options (generations only):
  --width N --height N | --size WIDTHxHEIGHT
                              each edge >= ${MIN_EDGE}px; width x height <= 2,359,296 (2.6 family)
                              or <= 1,048,576 (2.5 family, MAI-Image-2, MAI-Image-2e); default ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}`;
  if (command === "generate-batch") {
    console.log(`usage: image_gen.js generate-batch --input PATH --out-dir DIR [options]\n\n${shared}\n\n${size}\n\nbatch options:\n  --input PATH                JSONL jobs file\n  --out-dir DIR\n  --concurrency N             parallel requests, 1-10 (default: ${DEFAULT_CONCURRENCY})\n  --fail-fast`);
  } else if (command === "edit") {
    console.log(`usage: image_gen.js edit --image PATH [--image PATH ...] --prompt PROMPT [options]\n\n${shared}\n\nedit options:\n  --image PATH                PNG or JPEG reference image; repeat up to ${MAX_EDIT_IMAGES} times`);
  } else if (command === "generate") {
    console.log(`usage: image_gen.js generate --prompt PROMPT [options]\n\n${shared}\n\n${size}`);
  } else {
    console.log(`usage: image_gen.js {generate,generate-batch,edit} [options]\n\nImage generation and editing CLI for Microsoft Foundry MAI-Image series deployments.\nSupported base models: ${supportedModelList()}.`);
  }
}

const args = parseArgs(process.argv.slice(2));
validateTopLevel(args);
const handlers = { generate, edit, "generate-batch": generateBatch };
handlers[args.command](args).catch((error) => die(error.message || String(error)));
