#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.env.ITERADA_PINNED_NODE !== "1") {
  const runtimeCache = process.env.ITERADA_DELIVERY_CACHE || path.join(process.cwd(), ".iterada-delivery-cache");
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "--package", "node@22.23.5",
      "--package", "npm@10.9.2",
      "node", path.resolve(process.argv[1]),
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

function answer(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function cleanText(value, fallback = "Delivery failed") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 1800);
}

function validateRequest(value) {
  if (!value || value.schema_version !== 1 || typeof value.operation !== "string") {
    throw new Error("The delivery request is invalid.");
  }
  if (!value.target || typeof value.target !== "object" || Array.isArray(value.target)) {
    throw new Error("The delivery target is invalid.");
  }
  return value;
}

function commandSteps(request) {
  const commands = request.target.commands;
  if (!Array.isArray(commands)) return [];
  return commands.map((command, index) => ({
    id: String(command.id || `step-${index + 1}`),
    label: String(command.label || command.id || `Step ${index + 1}`),
    status: "pending",
    ...(index ? { depends_on: [String(commands[index - 1].id || `step-${index}`)] } : {}),
  }));
}

async function publishProgress(steps) {
  const destination = process.env.ITERADA_DELIVERY_PROGRESS;
  if (!destination) return;
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, JSON.stringify({ steps }), "utf8");
  await rename(temporary, destination);
}

function commandEnvironment() {
  const cache = process.env.ITERADA_DELIVERY_CACHE;
  if (!cache) return { ...process.env, TZ: "Europe/Warsaw" };
  const swcCache = path.join(cache, "swc-native");
  mkdirSync(swcCache, { recursive: true, mode: 0o700 });
  chmodSync(swcCache, 0o700);
  return {
    ...process.env,
    TZ: "Europe/Warsaw",
    npm_config_cache: path.join(cache, "npm"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(cache, "playwright"),
    SWC_NATIVE_BINDING_CACHE: swcCache,
  };
}

async function runCommands(request) {
  const commands = request.target.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("The command workflow has no commands.");
  }
  const steps = commandSteps(request);
  const startedAt = Date.now() / 1000;
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part) => typeof part !== "string")) {
      throw new Error(`Command ${steps[index].id} has invalid arguments.`);
    }
    steps[index] = { ...steps[index], status: "in_progress", started_at: Date.now() / 1000 };
    await publishProgress(steps);
    const result = spawnSync(command.argv[0], command.argv.slice(1), {
      cwd: process.cwd(),
      env: commandEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const finishedAt = Date.now() / 1000;
    if (result.error || result.status !== 0) {
      steps[index] = { ...steps[index], status: "failed", finished_at: finishedAt };
      await publishProgress(steps);
      return {
        state: "failed",
        detail: cleanText(result.error?.message || `Command ${steps[index].label} failed.`),
        exit_code: Number.isInteger(result.status) ? result.status : 1,
        started_at: startedAt,
        finished_at: finishedAt,
        steps,
      };
    }
    steps[index] = { ...steps[index], status: "succeeded", finished_at: finishedAt };
    await publishProgress(steps);
  }
  return {
    state: "succeeded",
    external_id: request.run_id,
    started_at: startedAt,
    finished_at: Date.now() / 1000,
    steps,
  };
}

function productionOrigin(target) {
  const value = new URL(String(target.origin || ""));
  if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/") {
    throw new Error("The production origin must be an HTTPS origin.");
  }
  return value.origin;
}

async function liveProbe(origin) {
  const started = performance.now();
  const response = await fetch(origin, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: response.ok, status: response.status, latencyMs: performance.now() - started };
}

async function observeHttp(request) {
  if (request.target.kind !== "http-observe") throw new Error("The observe workflow target is invalid.");
  const origin = productionOrigin(request.target);
  const capturedAt = Date.now() / 1000;
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => liveProbe(origin)));
  const probes = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const successful = probes.filter((probe) => probe.ok);
  const latencies = successful.map((probe) => probe.latencyMs).sort((left, right) => left - right);
  const representative = successful.at(-1) || probes.at(-1);
  const status = successful.length === results.length ? "healthy" : successful.length ? "degraded" : "down";
  return {
    status,
    detail: successful.length === results.length
      ? `Five production probes answered HTTP ${representative.status}.`
      : `${successful.length} of five production probes succeeded${representative ? `; the latest answered HTTP ${representative.status}` : ""}.`,
    metrics: {
      ...(latencies.length ? {
        latency_p50_ms: latencies[Math.floor((latencies.length - 1) * 0.5)],
        latency_p95_ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
      } : {}),
    },
    captured_at: capturedAt,
  };
}

async function handle(request) {
  if (request.operation === "inspect") return { state: "queued", steps: commandSteps(request) };
  if (request.operation === "metrics") return observeHttp(request);

  if (request.target.kind === "command") {
    if (request.operation === "start") return runCommands(request);
    if (request.operation === "cancel") {
      return { state: "cancelled", external_id: request.external_id, steps: commandSteps(request) };
    }
    return {
      state: "unknown",
      detail: "This command did not leave an external run to reconcile.",
      steps: commandSteps(request),
    };
  }

  throw new Error(`Unsupported delivery operation: ${request.operation}.`);
}

try {
  const request = validateRequest(JSON.parse(await new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  })));
  answer(await handle(request));
} catch (error) {
  answer({ state: "failed", detail: cleanText(error?.message), steps: [] });
}
