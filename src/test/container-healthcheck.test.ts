/// <reference types="node" />
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Vitest runs from the repository root, as `npm test` does.
const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

// Podman splits a health command on whitespace, so an argument holding a space
// (an inline `node -e "..."` script) reaches the container cut in half and every
// probe fails while the site itself is up.
function composeHealthcheckArguments(): string[] {
  const lines = read("compose.yaml").split("\n");
  const start = lines.findIndex((line) => line.trim() === "healthcheck:");
  expect(start).toBeGreaterThan(-1);
  const test = lines.findIndex((line, index) => index > start && line.trim() === "test:");
  expect(test).toBeGreaterThan(start);
  const args: string[] = [];
  for (const line of lines.slice(test + 1)) {
    const item = line.match(/^\s+- (.*)$/);
    if (!item) break;
    args.push(item[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return args;
}

function dockerfileHealthcheckArguments(): string[] {
  const match = read("Dockerfile").match(/^\s+CMD (\[.*\])$/m);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}

describe("container health command", () => {
  it("has no argument that contains whitespace in compose or the image", () => {
    const composeArgs = composeHealthcheckArguments();
    expect(composeArgs.slice(0, 2)).toEqual(["CMD", "node"]);
    for (const arg of [...composeArgs, ...dockerfileHealthcheckArguments()]) {
      expect(arg, `health command argument ${JSON.stringify(arg)}`).not.toMatch(/\s/);
    }
  });

  it("runs the same probe file in compose and the image, and the image ships it", () => {
    expect(composeHealthcheckArguments().slice(1)).toEqual(["node", "healthcheck.mjs"]);
    expect(dockerfileHealthcheckArguments()).toEqual(["node", "healthcheck.mjs"]);
    expect(read("Dockerfile")).toMatch(/COPY .*scripts\/healthcheck\.mjs/);
  });
});

describe("healthcheck.mjs", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  // Async on purpose: a blocking spawn would stop this process answering the probe.
  const probe = (port: number) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["scripts/healthcheck.mjs"], {
        cwd: root,
        env: { ...process.env, PORT: String(port) },
        timeout: 10_000,
      });
      child.once("close", resolve);
    });

  const listen = (status: number) =>
    new Promise<number>((resolve) => {
      server = createServer((_request, response) => response.writeHead(status).end("x"));
      server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
    });

  it("passes while the site answers 200", async () => {
    expect(await probe(await listen(200))).toBe(0);
  });

  it("fails when the site answers an error", async () => {
    expect(await probe(await listen(500))).toBe(1);
  });

  it("fails when nothing is listening", async () => {
    const port = await listen(200);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    expect(await probe(port)).toBe(1);
  });
});
