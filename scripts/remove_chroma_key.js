#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const KEY_DOMINANCE_THRESHOLD = 16.0;
const ALPHA_NOISE_FLOOR = 8;

function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function parseInteger(value, label) {
  if (/^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  die(`${label} must be an integer`);
}

function parseArgs(argv) {
  const args = {
    keyColor: "#00ff00",
    tolerance: 12,
    autoKey: "none",
    softMatte: false,
    transparentThreshold: 12.0,
    opaqueThreshold: 96.0,
    edgeFeather: 0.0,
    edgeContract: 0,
    spillCleanup: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`${token} requires a value`);
      return argv[++i];
    };
    switch (token) {
      case "--input":
        args.input = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--key-color":
        args.keyColor = next();
        break;
      case "--tolerance":
        args.tolerance = parseInteger(next(), "--tolerance");
        break;
      case "--auto-key":
        args.autoKey = next();
        break;
      case "--soft-matte":
        args.softMatte = true;
        break;
      case "--transparent-threshold":
        args.transparentThreshold = Number.parseFloat(next());
        break;
      case "--opaque-threshold":
        args.opaqueThreshold = Number.parseFloat(next());
        break;
      case "--edge-feather":
        args.edgeFeather = Number.parseFloat(next());
        break;
      case "--edge-contract":
        args.edgeContract = parseInteger(next(), "--edge-contract");
        break;
      case "--spill-cleanup":
      case "--despill":
        args.spillCleanup = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        die(`unrecognized argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`usage: remove_chroma_key.js --input INPUT --out OUT [options]

Remove a solid chroma-key background and write an image with alpha.

options:
  --input PATH                  Input image path.
  --out PATH                    Output .png or .webp path.
  --key-color HEX               Hex RGB key color to remove. Default: #00ff00.
  --tolerance N                 Hard-key per-channel tolerance, 0-255. Default: 12.
  --auto-key none|corners|border
  --soft-matte                  Use a smooth alpha ramp.
  --transparent-threshold N     Default: 12.0.
  --opaque-threshold N          Default: 96.0.
  --edge-feather N              Optional alpha blur radius, 0-64.
  --edge-contract N             Shrink visible alpha matte, 0-16.
  --spill-cleanup, --despill    Reduce key-color spill on edge pixels.
  --force                       Overwrite an existing output file.`);
}

function validateArgs(args) {
  if (!args.input) die("the following arguments are required: --input");
  if (!args.out) die("the following arguments are required: --out");
  if (!Number.isInteger(args.tolerance) || args.tolerance < 0 || args.tolerance > 255) {
    die("--tolerance must be between 0 and 255.");
  }
  if (!Number.isFinite(args.transparentThreshold) || args.transparentThreshold < 0 || args.transparentThreshold > 255) {
    die("--transparent-threshold must be between 0 and 255.");
  }
  if (!Number.isFinite(args.opaqueThreshold) || args.opaqueThreshold < 0 || args.opaqueThreshold > 255) {
    die("--opaque-threshold must be between 0 and 255.");
  }
  if (args.softMatte && args.transparentThreshold >= args.opaqueThreshold) {
    die("--transparent-threshold must be lower than --opaque-threshold.");
  }
  if (!Number.isFinite(args.edgeFeather) || args.edgeFeather < 0 || args.edgeFeather > 64) {
    die("--edge-feather must be between 0 and 64.");
  }
  if (!Number.isInteger(args.edgeContract) || args.edgeContract < 0 || args.edgeContract > 16) {
    die("--edge-contract must be between 0 and 16.");
  }
  if (!["none", "corners", "border"].includes(args.autoKey)) {
    die("argument --auto-key: invalid choice: must be none, corners, or border");
  }
  if (!fs.existsSync(args.input)) die(`Input image not found: ${args.input}`);
  if (fs.existsSync(args.out) && !args.force) {
    die(`Output already exists: ${args.out} (use --force to overwrite)`);
  }
  const ext = path.extname(args.out).toLowerCase();
  if (![".png", ".webp"].includes(ext)) {
    die("--out must end in .png or .webp so the alpha channel is preserved.");
  }
}

function parseKeyColor(raw) {
  const match = raw.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) die("key color must be a hex RGB value like #00ff00.");
  const hex = match[1];
  return [0, 2, 4].map((idx) => Number.parseInt(hex.slice(idx, idx + 2), 16));
}

function channelDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function pyRound(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, pyRound(value)));
}

function smoothstep(value) {
  const x = Math.max(0.0, Math.min(1.0, value));
  return x * x * (3.0 - 2.0 * x);
}

function softAlpha(distance, transparentThreshold, opaqueThreshold) {
  if (distance <= transparentThreshold) return 0;
  if (distance >= opaqueThreshold) return 255;
  const ratio = (distance - transparentThreshold) / (opaqueThreshold - transparentThreshold);
  return clampChannel(255.0 * smoothstep(ratio));
}

function spillChannels(key) {
  const keyMax = Math.max(...key);
  if (keyMax < 128) return [];
  return key.map((value, idx) => ({ value, idx }))
    .filter(({ value }) => value >= keyMax - 16 && value >= 128)
    .map(({ idx }) => idx);
}

function dominanceAlpha(rgb, key) {
  const channels = spillChannels(key);
  if (channels.length === 0) return 255;
  const values = rgb.map(Number);
  const nonSpill = [0, 1, 2].filter((idx) => !channels.includes(idx));
  const keyStrength = channels.length > 1
    ? Math.min(...channels.map((idx) => values[idx]))
    : values[channels[0]];
  const nonKeyStrength = nonSpill.length ? Math.max(...nonSpill.map((idx) => values[idx])) : 0.0;
  const dominance = keyStrength - nonKeyStrength;
  if (dominance <= 0) return 255;
  const denominator = Math.max(1.0, Math.max(...key) - nonKeyStrength);
  const alpha = 1.0 - Math.min(1.0, dominance / denominator);
  return clampChannel(alpha * 255.0);
}

function keyChannelDominance(rgb, key) {
  const channels = spillChannels(key);
  if (channels.length === 0) return 0.0;
  const values = rgb.map(Number);
  const nonSpill = [0, 1, 2].filter((idx) => !channels.includes(idx));
  const keyStrength = channels.length > 1
    ? Math.min(...channels.map((idx) => values[idx]))
    : values[channels[0]];
  const nonKeyStrength = nonSpill.length ? Math.max(...nonSpill.map((idx) => values[idx])) : 0.0;
  return keyStrength - nonKeyStrength;
}

function looksKeyColored(rgb, key, distance) {
  if (distance <= 32) return true;
  if (spillChannels(key).length === 0) return true;
  return keyChannelDominance(rgb, key) >= KEY_DOMINANCE_THRESHOLD;
}

function cleanupSpill(rgb, key, alpha = 255) {
  if (alpha >= 252) return rgb;
  const channels = spillChannels(key);
  if (channels.length === 0) return rgb;
  const values = rgb.map(Number);
  const nonSpill = [0, 1, 2].filter((idx) => !channels.includes(idx));
  if (nonSpill.length) {
    const cap = Math.max(0.0, Math.max(...nonSpill.map((idx) => values[idx])) - 1.0);
    for (const idx of channels) {
      if (values[idx] > cap) values[idx] = cap;
    }
  }
  return [clampChannel(values[0]), clampChannel(values[1]), clampChannel(values[2])];
}

function applyAlphaToImage(buffer, width, height, options) {
  let transparent = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      let red = buffer[offset];
      let green = buffer[offset + 1];
      let blue = buffer[offset + 2];
      const alpha = buffer[offset + 3];
      const rgb = [red, green, blue];
      const distance = channelDistance(rgb, options.key);
      const keyLike = looksKeyColored(rgb, options.key, distance);
      let outputAlpha = options.softMatte && keyLike
        ? Math.min(softAlpha(distance, options.transparentThreshold, options.opaqueThreshold), dominanceAlpha(rgb, options.key))
        : (distance <= options.tolerance ? 0 : 255);
      outputAlpha = pyRound(outputAlpha * (alpha / 255.0));
      if (outputAlpha > 0 && outputAlpha <= ALPHA_NOISE_FLOOR) outputAlpha = 0;
      if (outputAlpha === 0) {
        buffer[offset] = 0;
        buffer[offset + 1] = 0;
        buffer[offset + 2] = 0;
        buffer[offset + 3] = 0;
        transparent += 1;
        continue;
      }
      if (options.spillCleanup && keyLike) {
        [red, green, blue] = cleanupSpill(rgb, options.key, outputAlpha);
      }
      buffer[offset] = red;
      buffer[offset + 1] = green;
      buffer[offset + 2] = blue;
      buffer[offset + 3] = outputAlpha;
    }
  }
  return transparent;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleBorderKey(buffer, width, height, mode) {
  const samples = [];
  const push = (x, y) => {
    const offset = (y * width + x) * 4;
    samples.push([buffer[offset], buffer[offset + 1], buffer[offset + 2]]);
  };
  if (mode === "corners") {
    const patch = Math.max(1, Math.min(width, height, 12));
    const boxes = [
      [0, 0, patch, patch],
      [width - patch, 0, width, patch],
      [0, height - patch, patch, height],
      [width - patch, height - patch, width, height],
    ];
    for (const [left, top, right, bottom] of boxes) {
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) push(x, y);
      }
    }
  } else {
    const band = Math.max(1, Math.min(width, height, 6));
    const step = Math.max(1, Math.floor(Math.min(width, height) / 256));
    for (let x = 0; x < width; x += step) {
      for (let y = 0; y < band; y += 1) {
        push(x, y);
        push(x, height - 1 - y);
      }
    }
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < band; x += 1) {
        push(x, y);
        push(width - 1 - x, y);
      }
    }
  }
  if (samples.length === 0) die("Could not sample background key color from image border.");
  return [0, 1, 2].map((idx) => pyRound(median(samples.map((sample) => sample[idx]))));
}

function contractAlpha(buffer, width, height, pixels) {
  for (let iteration = 0; iteration < pixels; iteration += 1) {
    const source = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i += 1) source[i] = buffer[i * 4 + 3];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let min = 255;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = Math.max(0, Math.min(height - 1, y + dy));
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = Math.max(0, Math.min(width - 1, x + dx));
            min = Math.min(min, source[yy * width + xx]);
          }
        }
        buffer[(y * width + x) * 4 + 3] = min;
      }
    }
  }
}

async function applyEdgeFeather(buffer, width, height, radius) {
  if (radius === 0) return;
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) alpha[i] = buffer[i * 4 + 3];
  const blurred = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(radius)
    .raw()
    .toBuffer();
  for (let i = 0; i < width * height; i += 1) buffer[i * 4 + 3] = blurred[i];
}

function alphaCounts(buffer, width, height) {
  let transparent = 0;
  let partial = 0;
  const total = width * height;
  for (let i = 0; i < total; i += 1) {
    const alpha = buffer[i * 4 + 3];
    if (alpha === 0) transparent += 1;
    else if (alpha < 255) partial += 1;
  }
  return { total, transparent, partial };
}

async function encodeImage(buffer, width, height, outputFormat) {
  const image = sharp(buffer, { raw: { width, height, channels: 4 } });
  return outputFormat === "PNG" ? image.png().toBuffer() : image.webp().toBuffer();
}

async function removeChromaKey(args) {
  const { data, info } = await sharp(args.input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.from(data);
  const key = args.autoKey !== "none"
    ? sampleBorderKey(rgba, info.width, info.height, args.autoKey)
    : parseKeyColor(args.keyColor);
  const transparentBefore = applyAlphaToImage(rgba, info.width, info.height, {
    key,
    tolerance: args.tolerance,
    spillCleanup: args.spillCleanup,
    softMatte: args.softMatte,
    transparentThreshold: args.transparentThreshold,
    opaqueThreshold: args.opaqueThreshold,
  });
  contractAlpha(rgba, info.width, info.height, args.edgeContract);
  await applyEdgeFeather(rgba, info.width, info.height, args.edgeFeather);
  const counts = alphaCounts(rgba, info.width, info.height);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const outputFormat = path.extname(args.out).toLowerCase() === ".png" ? "PNG" : "WEBP";
  fs.writeFileSync(args.out, await encodeImage(rgba, info.width, info.height, outputFormat));
  console.log(`Wrote ${args.out}`);
  console.log(`Key color: #${key.map((value) => value.toString(16).padStart(2, "0")).join("")}`);
  console.log(`Transparent pixels: ${counts.transparent}/${counts.total}`);
  console.log(`Partially transparent pixels: ${counts.partial}/${counts.total}`);
  if (transparentBefore === 0) {
    console.error("Warning: no pixels matched the key color before feathering.");
  }
}

const args = parseArgs(process.argv.slice(2));
validateArgs(args);
removeChromaKey(args).catch((error) => die(error.message || String(error)));
