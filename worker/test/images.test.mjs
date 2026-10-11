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
    extra: { dockerfile: "img/Dockerfile" },
    tools: { image: `registry.cloudflare.com/acct/repo@sha256:${"a".repeat(64)}` },
  }, "/ops");
  const images = out.containers[0].images;
  assert.deepEqual(images.extra, { dockerfile: "/ops/img/Dockerfile", build_context: "/ops/img" });
  assert.equal(images.tools.image.endsWith("a".repeat(64)), true);
  assert.equal(images.hermes.dockerfile, "./container/Dockerfile");
  assert.equal(config.containers[0].images.extra, undefined); // input untouched
});

test("unsafe or ambiguous image entries are refused", () => {
  for (const bad of [
    { hermes: { dockerfile: "x" } },
    { "bad name": { dockerfile: "x" } },
    { a: { dockerfile: "x", image: "y" } },
    { a: { image: "docker.io/library/node:24" } },
    { a: { image: "registry.cloudflare.com/acct/repo:latest" } },
    { a: {} },
    JSON.parse('{"__proto__": {"dockerfile": "x"}}'),
  ]) assert.throws(() => withImages(config, bad, "/ops"));
});

test("jsonc comments and trailing commas are handled without touching strings", () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x/*y*/", /* z */ "b": [1,], }'), { a: "http://x/*y*/", b: [1] });
});

test("commas before } or ] inside strings are kept", () => {
  assert.deepEqual(parseJsonc('{"vars": {"VALUE": "x,}", "L": "[a, ]"}, "k": [1, /* c */ ], }'),
                   { vars: { VALUE: "x,}", L: "[a, ]" }, k: [1] });
});

test("more than 100 images in total are refused", () => {
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`img${i}`, { dockerfile: "Dockerfile" }]));
  assert.throws(() => withImages(config, many, "/ops"), /too many images: 101/);
  delete many.img99;
  assert.equal(Object.keys(withImages(config, many, "/ops").containers[0].images).length, 100);
});
