import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "image_gen.js");
// 1x1 transparent PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let server;
let baseUrl;
let tmp;
const requests = [];
let queuedStatuses = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imagegen-mai-test-"));
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const status = queuedStatuses.shift() ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json", "Retry-After": "0" });
        res.end(JSON.stringify({ error: { code: String(status) } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args, env = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("IMAGEGEN_MAI_")));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: tmp,
      env: { ...cleanEnv, IMAGEGEN_MAI_ENDPOINT: `${baseUrl}/mai/v1`, IMAGEGEN_MAI_API_KEY: "test-key", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function resetServer(statuses = []) {
  requests.length = 0;
  queuedStatuses = [...statuses];
}

test("generate sends the MAI JSON payload to /mai/v1/images/generations", async () => {
  resetServer();
  const out = path.join(tmp, "gen.png");
  const { code, stderr } = await run(["generate", "--prompt", "a red kite", "--no-augment", "--size", "1536x1024", "--web-grounding", "--out", out]);
  assert.equal(code, 0, stderr);
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.equal(req.url, "/mai/v1/images/generations");
  assert.equal(req.headers["api-key"], "test-key");
  assert.deepEqual(JSON.parse(req.body), {
    model: "MAI-Image-2.6-Flash",
    prompt: "a red kite",
    width: 1536,
    height: 1024,
    web_grounding: true,
  });
  assert.equal(fs.readFileSync(out).toString("base64"), PNG_B64);
});

test("bearer token is used when no API key is set", async () => {
  resetServer();
  const { code, stderr } = await run(
    ["generate", "--prompt", "x", "--out", path.join(tmp, "bearer.png")],
    { IMAGEGEN_MAI_API_KEY: "", IMAGEGEN_MAI_AUTH_TOKEN: "tok" },
  );
  assert.equal(code, 0, stderr);
  assert.equal(requests[0].headers.authorization, "Bearer tok");
  assert.equal(requests[0].headers["api-key"], undefined);
});

test("edit sends multipart form with model field and repeated image parts", async () => {
  resetServer();
  const png = path.join(tmp, "a.png");
  const jpg = path.join(tmp, "b.jpg");
  fs.writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  fs.writeFileSync(jpg, JPEG_HEADER);
  const { code, stderr } = await run(["edit", "--image", png, "--image", jpg, "--prompt", "merge", "--no-augment", "--auto-aspect-ratio", "--out", path.join(tmp, "edit.png")]);
  assert.equal(code, 0, stderr);
  const [req] = requests;
  assert.equal(req.url, "/mai/v1/images/edits");
  assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
  const body = req.body.toString("latin1");
  assert.match(body, /name="model"\r\n\r\nMAI-Image-2\.6-Flash\r\n/);
  assert.match(body, /name="prompt"\r\n\r\nmerge\r\n/);
  assert.match(body, /name="auto_aspect_ratio"\r\n\r\ntrue\r\n/);
  assert.match(body, /name="image"; filename="a\.png"\r\nContent-Type: image\/png/);
  assert.match(body, /name="image"; filename="b\.jpg"\r\nContent-Type: image\/jpeg/);
  assert.doesNotMatch(body, /name="width"/);
});

test("generate retries on 429 and then succeeds", async () => {
  resetServer([429]);
  const { code, stderr } = await run(["generate", "--prompt", "x", "--out", path.join(tmp, "retry.png")]);
  assert.equal(code, 0, stderr);
  assert.equal(requests.length, 2);
  assert.match(stderr, /attempt 1\/3 failed \(429\)/);
});

test("non-transient errors fail without retry", async () => {
  resetServer([400]);
  const { code, stderr } = await run(["generate", "--prompt", "x", "--out", path.join(tmp, "bad.png")]);
  assert.equal(code, 1);
  assert.equal(requests.length, 1);
  assert.match(stderr, /400/);
});

test("generate-batch applies per-job overrides and writes every output", async () => {
  resetServer();
  const jsonl = path.join(tmp, "jobs.jsonl");
  fs.writeFileSync(jsonl, [
    "# comment",
    "plain prompt line",
    JSON.stringify({ prompt: "wide", width: 1536, height: 768, out: "wide.png", style: "watercolor" }),
    JSON.stringify({ prompt: "older", model: "MAI-Image-2.5", size: "1024x1024" }),
  ].join("\n"));
  const outDir = path.join(tmp, "batch");
  const { code, stderr } = await run(["generate-batch", "--input", jsonl, "--out-dir", outDir, "--concurrency", "1"]);
  assert.equal(code, 0, stderr);
  assert.equal(requests.length, 3);
  const bodies = requests.map((r) => JSON.parse(r.body));
  assert.deepEqual([bodies[0].width, bodies[0].height], [1024, 1024]);
  assert.deepEqual([bodies[1].width, bodies[1].height], [1536, 768]);
  assert.match(bodies[1].prompt, /Style\/medium: watercolor/);
  assert.equal(bodies[2].model, "MAI-Image-2.5");
  assert.deepEqual(fs.readdirSync(outDir).sort(), ["001-plain-prompt-line.png", "003-older.png", "wide.png"]);
});

test("generate-batch validates all jobs before calling the API", async () => {
  resetServer();
  const jsonl = path.join(tmp, "bad-jobs.jsonl");
  fs.writeFileSync(jsonl, ["ok", JSON.stringify({ prompt: "too big", size: "2048x2048" })].join("\n"));
  const { code, stderr } = await run(["generate-batch", "--input", jsonl, "--out-dir", path.join(tmp, "bad-batch")]);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(stderr, /job 2: MAI-Image-2\.6-Flash width x height must not exceed 2,359,296/);
});

const rejections = [
  [["generate", "--prompt", "x", "--model", "gpt-image-2.5-flare"], /not a known MAI-Image model name/],
  [["generate", "--prompt", "x", "--model", "custom", "--base-model", "dall-e-3"], /not a supported MAI-Image model/],
  [["generate", "--prompt", "x", "--size", "1600x1536"], /must not exceed 2,359,296/],
  [["generate", "--prompt", "x", "--model", "MAI-Image-2.5-Pro", "--size", "1280x1024"], /must not exceed 1,048,576/],
  [["generate", "--prompt", "x", "--size", "767x1024"], /at least 768px/],
  [["generate", "--prompt", "x", "--height", "1024"], /set together/],
  [["generate", "--prompt", "x", "--size", "1024x1024", "--width", "1024"], /not both/],
  [["generate", "--prompt", "x", "--model", "MAI-Image-2.5-Flash", "--auto-aspect-ratio"], /apply only to MAI-Image-2\.6/],
  [["generate", "--prompt", "x", "--quality", "high"], /unrecognized argument/],
  [["generate", "--prompt", "x", "--background", "transparent"], /unrecognized argument/],
  [["edit", "--prompt", "x", "--image", "missing.png"], /Image file not found/],
  [["edit", "--prompt", "x", "--image", "a.png", "--size", "1024x1024"], /generations API only/],
  [["edit", "--prompt", "x", "--image", "a.png", "--model", "MAI-Image-2"], /documented for text-to-image generation only/],
];

for (const [args, pattern] of rejections) {
  test(`rejects: ${args.slice(1).join(" ")}`, async () => {
    resetServer();
    fs.writeFileSync(path.join(tmp, "a.png"), Buffer.from(PNG_B64, "base64"));
    const { code, stderr } = await run([...args, "--dry-run"]);
    assert.equal(code, 1, stderr);
    assert.match(stderr, pattern);
    assert.equal(requests.length, 0);
  });
}

test("edit rejects more than five images and non-image files", async () => {
  const png = path.join(tmp, "a.png");
  fs.writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  const six = Array.from({ length: 6 }, () => ["--image", png]).flat();
  let result = await run(["edit", "--prompt", "x", ...six, "--dry-run"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /at most 5/);
  const txt = path.join(tmp, "note.txt");
  fs.writeFileSync(txt, "not an image");
  result = await run(["edit", "--prompt", "x", "--image", txt, "--dry-run"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PNG or JPEG/);
});

test("custom deployment name works with IMAGEGEN_MAI_BASE_MODEL", async () => {
  const { code, stdout, stderr } = await run(
    ["generate", "--prompt", "x", "--no-augment", "--dry-run"],
    { IMAGEGEN_MAI_IMAGE_DEPLOYMENT: "prod-flash", IMAGEGEN_MAI_BASE_MODEL: "MAI-Image-2.6-Flash" },
  );
  assert.equal(code, 0, stderr);
  const request = JSON.parse(stdout);
  assert.equal(request.model, "prod-flash");
  assert.equal(request.base_model, "MAI-Image-2.6-Flash");
});

test("auto aspect ratio without size omits width and height", async () => {
  const { code, stdout, stderr } = await run(["generate", "--prompt", "x", "--auto-aspect-ratio", "--dry-run"]);
  assert.equal(code, 0, stderr);
  const request = JSON.parse(stdout);
  assert.equal(request.auto_aspect_ratio, true);
  assert.equal(request.width, undefined);
  assert.equal(request.height, undefined);
});

test("existing output is not overwritten without --force", async () => {
  resetServer();
  const out = path.join(tmp, "exists.png");
  fs.writeFileSync(out, "keep");
  const { code, stderr } = await run(["generate", "--prompt", "x", "--out", out]);
  assert.equal(code, 1);
  assert.match(stderr, /already exists/);
  assert.equal(requests.length, 0);
  assert.equal(fs.readFileSync(out, "utf8"), "keep");
});
