#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

if (process.env.ITERADA_PINNED_NODE !== "1") {
  const runtimeCache = process.env.ITERADA_DELIVERY_CACHE || path.join(process.cwd(), ".iterada-delivery-cache");
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "--package", "node@22.23.5",
      "--package", "npm@10.9.2",
      "node", new URL(import.meta.url).pathname,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ITERADA_PINNED_NODE: "1",
        npm_config_cache: path.join(runtimeCache, "npm"),
      },
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}
if (process.versions.node !== "22.23.5") throw new Error("The pinned Node.js 22.23.5 runtime did not start.");

const host = "127.0.0.1";
const port = Number(process.env.PRODUCT_TEST_PORT || 4180);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PRODUCT_TEST_PORT must be a non-privileged TCP port.");
}

const deliveryCache = process.env.ITERADA_DELIVERY_CACHE || path.join(process.cwd(), ".iterada-delivery-cache");
const swcCache = path.join(deliveryCache, "swc-native");
mkdirSync(swcCache, { recursive: true, mode: 0o700 });
chmodSync(swcCache, 0o700);
process.env.SWC_NATIVE_BINDING_CACHE = swcCache;
process.env.TZ = "Europe/Warsaw";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${command} ${args.join(" ")} failed.`);
  }
}

if (!(await exists("node_modules/.bin/vite"))) run("npm", ["ci"]);
run("npm", ["run", "build"]);

const distDir = path.resolve("dist");
const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    const relative = decodeURIComponent(url.pathname) === "/"
      ? "index.html"
      : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = path.resolve(distDir, relative);
    const insideDist = candidate === distDir || candidate.startsWith(`${distDir}${path.sep}`);
    const found = insideDist && (await stat(candidate).catch(() => null))?.isFile();
    const file = found ? candidate : path.join(distDir, "404.html");
    const body = await readFile(file);
    response.statusCode = found ? 200 : 404;
    response.setHeader("Content-Type", contentTypes.get(path.extname(file)) || "application/octet-stream");
    response.setHeader("Content-Length", body.length);
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.statusCode = 500;
    response.end("Private product copy failed to serve this request.");
  }
});

const origin = `http://${host}:${port}`;
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});

console.log(`Product test copy ready: ${origin}`);
console.log(`iterada-browser open ${origin}`);
console.log("Stand-ins: none; this static landing page uses no paid or third-party APIs.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
