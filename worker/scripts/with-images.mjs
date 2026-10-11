#!/usr/bin/env node
// Add operator-defined named images to wrangler.jsonc without editing it.
//
//   node scripts/with-images.mjs images.json [wrangler.generated.jsonc]
//   npx wrangler deploy --config wrangler.generated.jsonc
//
// images.json maps a name to exactly one source, as in wrangler's `images`:
//   { "extra": { "dockerfile": "/abs/or/relative/Dockerfile", "build_context": "..." },
//     "tools": { "image": "registry.cloudflare.com/<account>/<repo>@sha256:<digest>" } }
// Relative paths are resolved from the directory of images.json. The built-in
// "hermes" image cannot be replaced. See docs/custom-images.md.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const DIGEST = /^registry\.cloudflare\.com\/[^@\s]+@sha256:[a-f0-9]{64}$/;

/** Remove comments and trailing commas outside strings, then parse as JSON. */
export function parseJsonc(text) {
  let out = "", i = 0, inString = false;
  const skipBlank = from => {
    // Whitespace and comments after a comma, to see whether it is trailing.
    for (let j = from; j < text.length;) {
      if (/\s/.test(text[j])) j++;
      else if (text[j] === "/" && text[j + 1] === "/") { while (j < text.length && text[j] !== "\n") j++; }
      else if (text[j] === "/" && text[j + 1] === "*") { const end = text.indexOf("*/", j + 2); j = end < 0 ? text.length : end + 2; }
      else return text[j];
    }
    return undefined;
  };
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') { inString = true; out += c; i++; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); i = i < 0 ? text.length : i + 2; }
    else if (c === "," && ["}", "]"].includes(skipBlank(i + 1))) i++;
    else { out += c; i++; }
  }
  return JSON.parse(out);
}

export function withImages(config, images, base) {
  if (!images || typeof images !== "object" || Array.isArray(images)) throw new Error("images file must be a JSON object");
  const container = config.containers?.[0];
  if (!container?.images) throw new Error("wrangler.jsonc has no containers[0].images");
  const merged = { ...container.images };
  for (const [name, source] of Object.entries(images)) {
    if (!NAME.test(name)) throw new Error(`invalid image name: ${name}`);
    if (name === "__proto__") throw new Error("__proto__ cannot be an image name");
    if (name === "hermes") throw new Error('"hermes" is the built-in image; choose another name');
    const keys = Object.keys(source ?? {});
    if (typeof source?.dockerfile === "string" && keys.every(k => ["dockerfile", "build_context", "build_vars"].includes(k))) {
      merged[name] = {
        ...source,
        dockerfile: resolve(base, source.dockerfile),
        build_context: resolve(base, source.build_context ?? dirname(source.dockerfile)),
      };
    } else if (typeof source?.image === "string" && keys.length === 1) {
      if (!DIGEST.test(source.image)) throw new Error(`${name}: image must be registry.cloudflare.com/...@sha256:<digest>`);
      merged[name] = { image: source.image };
    } else {
      throw new Error(`${name}: use either {"dockerfile", "build_context"?} or {"image"}`);
    }
  }
  // Cloudflare allows at most 100 named images per configuration.
  if (Object.keys(merged).length > 100) {
    throw new Error(`too many images: ${Object.keys(merged).length} (Cloudflare allows 100, including "hermes")`);
  }
  return { ...config, containers: [{ ...container, images: merged }, ...config.containers.slice(1)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [imagesPath, outPath = "wrangler.generated.jsonc"] = process.argv.slice(2);
  if (!imagesPath) {
    console.error("usage: node scripts/with-images.mjs images.json [wrangler.generated.jsonc]");
    process.exit(64);
  }
  // Paths in wrangler.jsonc are relative to worker/, so the output must sit there too.
  if (basename(outPath) !== outPath || !outPath.endsWith(".jsonc") || outPath === "wrangler.jsonc") {
    console.error("output must be a file name ending in .jsonc (written in worker/), not wrangler.jsonc");
    process.exit(64);
  }
  const config = parseJsonc(readFileSync(resolve(here, "wrangler.jsonc"), "utf8"));
  const images = JSON.parse(readFileSync(imagesPath, "utf8"));
  const result = withImages(config, images, dirname(resolve(imagesPath)));
  const target = resolve(here, outPath);
  // Compare file identities, not names: on a case-insensitive filesystem
  // "Wrangler.jsonc" is the same file as wrangler.jsonc.
  const same = (a, b) => {
    const x = statSync(a, { throwIfNoEntry: false }), y = statSync(b, { throwIfNoEntry: false });
    return Boolean(x && y && x.dev === y.dev && x.ino === y.ino);
  };
  if (same(target, resolve(here, "wrangler.jsonc")) || same(target, resolve(imagesPath)) || target === resolve(imagesPath)) {
    console.error("output would overwrite wrangler.jsonc or the image list; choose another name");
    process.exit(64);
  }
  writeFileSync(target, "// Generated by scripts/with-images.mjs; do not edit.\n" + JSON.stringify(result, null, 2) + "\n");
  console.log(`${target}: images ${Object.keys(result.containers[0].images).join(", ")}`);
}
