#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8080);
const distDir = path.resolve(process.env.STATIC_ROOT || "dist");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a TCP port number.");
}

const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

function sendFile(request, response, file, statusCode, cacheControl) {
  const stream = createReadStream(file);
  stream.once("error", () => {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("The site could not read this file.");
  });
  response.writeHead(statusCode, {
    "Cache-Control": cacheControl,
    "Content-Type": contentTypes.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    stream.destroy();
    response.end();
    return;
  }
  stream.pipe(response);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed.");
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    const requestHost = String(request.headers.host || "").split(":", 1)[0].toLowerCase();
    if (requestHost === "www.odswoich.pl") {
      response.writeHead(308, { Location: `https://odswoich.pl${url.pathname}${url.search}` });
      response.end();
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = path.resolve(distDir, relative);
    const insideDist = candidate === distDir || candidate.startsWith(`${distDir}${path.sep}`);
    const found = insideDist && (await stat(candidate).catch(() => null))?.isFile();
    const file = found ? candidate : path.join(distDir, "404.html");
    const cacheControl = found && relative.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate";
    sendFile(request, response, file, found ? 200 : 404, cacheControl);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request.");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});

console.log(`Static site ready at http://${host}:${port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
