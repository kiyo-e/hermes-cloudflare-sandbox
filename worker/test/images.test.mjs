import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc, withImages } from "../scripts/with-images.mjs";

const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("the repository wrangler.jsonc parses and keeps the built-in image", () => {
  assert.equal(config.containers[0].images.hermes.dockerfile, "./container/Dockerfile");
  assert.equal(config.vars.ENABLE_INTERNET, "true");
});

test("custom images are added; relative paths resolve from the images file", () => {
  const out = withImages(config, {
    "cf-hermes": { dockerfile: "img/Dockerfile" },
    tools: { image: `registry.cloudflare.com/acct/repo@sha256:${"a".repeat(64)}` },
  }, "/ops");
  const images = out.containers[0].images;
  assert.deepEqual(images["cf-hermes"], { dockerfile: "/ops/img/Dockerfile", build_context: "/ops/img" });
  assert.equal(images.tools.image.endsWith("a".repeat(64)), true);
  assert.equal(images.hermes.dockerfile, "./container/Dockerfile");
  assert.equal(config.containers[0].images["cf-hermes"], undefined); // input untouched
});

test("unsafe or ambiguous image entries are refused", () => {
  for (const bad of [
    { hermes: { dockerfile: "x" } },
    { "bad name": { dockerfile: "x" } },
    { a: { dockerfile: "x", image: "y" } },
    { a: { image: "docker.io/library/node:24" } },
    { a: { image: "registry.cloudflare.com/acct/repo:latest" } },
    { a: {} },
  ]) assert.throws(() => withImages(config, bad, "/ops"));
});

test("jsonc comments and trailing commas are handled without touching strings", () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x/*y*/", /* z */ "b": [1,], }'), { a: "http://x/*y*/", b: [1] });
});
