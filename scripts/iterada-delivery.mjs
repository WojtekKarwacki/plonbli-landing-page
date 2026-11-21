#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const NETLIFY_API = process.env.ITERADA_DELIVERY_TEST_API_BASE ?? "https://api.netlify.com/api/v1";
const ACTIVE_DEPLOY_STATES = new Set([
  "new",
  "pending_review",
  "accepted",
  "enqueued",
  "building",
  "uploading",
  "uploaded",
  "processing",
  "prepared",
  "retrying",
]);
const FAILED_DEPLOY_STATES = new Set(["error", "failed"]);

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

function targetSteps(request) {
  const commands = request.target.commands;
  if (Array.isArray(commands)) {
    return commands.map((command, index) => ({
      id: String(command.id || `step-${index + 1}`),
      label: String(command.label || command.id || `Step ${index + 1}`),
      status: "pending",
      ...(index ? { depends_on: [String(commands[index - 1].id || `step-${index}`)] } : {}),
    }));
  }
  const plans = {
    "netlify-deploy": [
      ["dispatch", "Queue the Netlify build"],
      ["build", "Build the release on Netlify", ["dispatch"]],
      ["publish", "Publish the atomic deploy", ["build"]],
      ["verify", "Verify the production site", ["publish"]],
    ],
    "netlify-rollback": [
      ["locate", "Locate the previous Netlify deploy"],
      ["restore", "Restore the atomic deploy", ["locate"]],
      ["verify", "Verify the restored production site", ["restore"]],
    ],
  };
  return (plans[request.target.kind] || []).map(([id, label, dependsOn]) => ({
    id,
    label,
    status: "pending",
    ...(dependsOn ? { depends_on: dependsOn } : {}),
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
  if (!cache) return process.env;
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
  const steps = targetSteps(request);
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

function siteId(target) {
  const value = String(target.site_id || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error("The Netlify site identifier is invalid.");
  return value;
}

function productionOrigin(target) {
  const value = new URL(String(target.origin || ""));
  if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/") {
    throw new Error("The production origin must be an HTTPS origin.");
  }
  return value.origin;
}

function netlifyHeaders({ authenticated = true } = {}) {
  const headers = { Accept: "application/json" };
  if (authenticated) {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) throw new Error("NETLIFY_AUTH_TOKEN is required for Netlify delivery.");
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function netlify(pathname, { method = "GET", authenticated = true } = {}) {
  const response = await fetch(`${NETLIFY_API}${pathname}`, {
    method,
    headers: netlifyHeaders({ authenticated }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const message = body?.message || body?.error || `${response.status} ${response.statusText}`;
    throw new Error(`Netlify API request failed: ${cleanText(message)}.`);
  }
  return body;
}

function deployMarker(request) {
  return `Iterada ${request.run_id} ${request.revision.slice(0, 12)}`;
}

async function listDeploys(request, { authenticated = true } = {}) {
  const id = siteId(request.target);
  const value = await netlify(`/sites/${encodeURIComponent(id)}/deploys?per_page=100`, { authenticated });
  return Array.isArray(value) ? value : [];
}

function matchingDeploy(deploys, request, { markerOnly = false } = {}) {
  const marker = deployMarker(request);
  const revision = String(request.inputs?.target_revision || request.revision);
  return deploys.find((deploy) => deploy?.title === marker)
    || (!markerOnly && deploys.find((deploy) => deploy?.commit_ref === revision && deploy?.context === "production"));
}

function externalId(kind, buildId, deployId) {
  return ["netlify", kind, buildId || "-", deployId || "-"].join(":");
}

function parseExternalId(value) {
  const [provider, kind, buildId, deployId] = String(value || "").split(":");
  if (provider !== "netlify" || !kind) return null;
  return { kind, buildId: buildId === "-" ? null : buildId, deployId: deployId === "-" ? null : deployId };
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

async function currentSite(request, { authenticated = true } = {}) {
  return netlify(`/sites/${encodeURIComponent(siteId(request.target))}`, { authenticated });
}

function deployStepState(deployState, published, probeOk) {
  if (FAILED_DEPLOY_STATES.has(deployState)) return ["succeeded", "failed", "pending", "pending"];
  if (deployState === "cancelled") return ["succeeded", "cancelled", "cancelled", "cancelled"];
  if (ACTIVE_DEPLOY_STATES.has(deployState) || !deployState) return ["succeeded", "in_progress", "pending", "pending"];
  if (!published) return ["succeeded", "succeeded", "in_progress", "pending"];
  return ["succeeded", "succeeded", "succeeded", probeOk ? "succeeded" : "failed"];
}

async function deploySnapshot(request, deploy, parsedExternal = null) {
  const deployId = deploy?.id || parsedExternal?.deployId;
  const buildId = deploy?.build_id || parsedExternal?.buildId;
  let published = false;
  let probe = { ok: false, status: 0, latencyMs: 0 };
  if (deploy && !ACTIVE_DEPLOY_STATES.has(deploy.state) && !FAILED_DEPLOY_STATES.has(deploy.state)) {
    const site = await currentSite(request);
    const targetRevision = String(request.inputs?.target_revision || request.revision);
    published = site?.published_deploy?.id === deployId || site?.published_deploy?.commit_ref === targetRevision;
    if (published) probe = await liveProbe(productionOrigin(request.target));
  }
  const statuses = deployStepState(deploy?.state, published, probe.ok);
  const steps = targetSteps(request).map((step, index) => ({
    ...step,
    status: statuses[index],
    ...(deploy?.admin_url ? { log_ref: String(deploy.admin_url) } : {}),
  }));
  if (FAILED_DEPLOY_STATES.has(deploy?.state)) {
    return {
      state: "failed",
      external_id: externalId("build", buildId, deployId),
      detail: cleanText(deploy?.error_message || deploy?.error || "Netlify could not build the release."),
      steps,
    };
  }
  if (deploy?.state === "cancelled") {
    return { state: "cancelled", external_id: externalId("build", buildId, deployId), steps };
  }
  if (published && probe.ok) {
    return {
      state: "succeeded",
      external_id: externalId("build", buildId, deployId),
      detail: `Netlify published ${request.revision.slice(0, 12)} and production answered HTTP ${probe.status}.`,
      steps,
    };
  }
  if (published && !probe.ok) {
    return {
      state: "failed",
      external_id: externalId("build", buildId, deployId),
      detail: `Netlify published the release, but production answered HTTP ${probe.status || "unavailable"}.`,
      steps,
    };
  }
  return {
    state: "running",
    external_id: externalId("build", buildId, deployId),
    detail: "Netlify is building or publishing the requested revision.",
    steps,
  };
}

async function findDeployForRun(request, parsedExternal = null) {
  if (parsedExternal?.deployId) {
    return netlify(`/deploys/${encodeURIComponent(parsedExternal.deployId)}`);
  }
  return matchingDeploy(await listDeploys(request), request);
}

async function startNetlifyDeploy(request) {
  const existing = matchingDeploy(await listDeploys(request), request);
  if (existing) return deploySnapshot(request, existing);

  const query = new URLSearchParams({
    branch: String(request.target.branch || "main"),
    commit_sha: request.revision,
    title: deployMarker(request),
  });
  const build = await netlify(`/sites/${encodeURIComponent(siteId(request.target))}/builds?${query}`, { method: "POST" });
  if (!build?.id) throw new Error("Netlify did not return a build identifier.");
  const parsed = { kind: "build", buildId: build.id, deployId: build.deploy_id || null };
  if (parsed.deployId) {
    const deploy = await netlify(`/deploys/${encodeURIComponent(parsed.deployId)}`);
    return deploySnapshot(request, deploy, parsed);
  }
  return {
    state: "running",
    external_id: externalId("build", parsed.buildId, null),
    detail: "Netlify queued the requested revision for production.",
    steps: targetSteps(request).map((step, index) => ({ ...step, status: index === 0 ? "succeeded" : index === 1 ? "in_progress" : "pending" })),
  };
}

async function statusNetlifyDeploy(request) {
  const parsed = parseExternalId(request.external_id);
  let deploy = await findDeployForRun(request, parsed);
  if (!deploy && parsed?.buildId) {
    const build = await netlify(`/builds/${encodeURIComponent(parsed.buildId)}`);
    if (build?.deploy_id) deploy = await netlify(`/deploys/${encodeURIComponent(build.deploy_id)}`);
    else if (build?.done && build?.error) {
      return { state: "failed", external_id: request.external_id, detail: cleanText(build.error), steps: targetSteps(request) };
    }
  }
  if (!deploy) {
    return {
      state: "unknown",
      detail: "Netlify has not exposed the requested build yet; reconciliation will retry without starting a duplicate.",
      steps: targetSteps(request),
    };
  }
  return deploySnapshot(request, deploy, parsed);
}

async function cancelNetlifyDeploy(request) {
  const parsed = parseExternalId(request.external_id);
  const deploy = await findDeployForRun(request, parsed);
  if (!deploy?.id) return { state: "cancelled", external_id: request.external_id, steps: targetSteps(request) };
  if (!ACTIVE_DEPLOY_STATES.has(deploy.state)) return deploySnapshot(request, deploy, parsed);
  const cancelled = await netlify(`/deploys/${encodeURIComponent(deploy.id)}/cancel`, { method: "POST" });
  return {
    state: "cancelled",
    external_id: externalId("build", cancelled?.build_id || deploy.build_id, deploy.id),
    detail: "Netlify cancelled the production build.",
    steps: targetSteps(request).map((step, index) => ({ ...step, status: index === 0 ? "succeeded" : "cancelled" })),
  };
}

async function rollbackSnapshot(request, deploy) {
  const site = await currentSite(request);
  const revision = String(request.inputs?.target_revision || request.revision);
  const published = site?.published_deploy?.id === deploy?.id || site?.published_deploy?.commit_ref === revision;
  const probe = published ? await liveProbe(productionOrigin(request.target)) : { ok: false, status: 0 };
  const state = published && probe.ok ? "succeeded" : published ? "failed" : "running";
  const statuses = state === "succeeded"
    ? ["succeeded", "succeeded", "succeeded"]
    : state === "failed"
      ? ["succeeded", "succeeded", "failed"]
      : ["succeeded", "in_progress", "pending"];
  return {
    state,
    external_id: externalId("restore", null, deploy?.id),
    detail: state === "succeeded"
      ? `Netlify restored ${revision.slice(0, 12)} and production answered HTTP ${probe.status}.`
      : state === "failed"
        ? `Netlify restored the deploy, but production answered HTTP ${probe.status || "unavailable"}.`
        : "Netlify is restoring the previous atomic deploy.",
    steps: targetSteps(request).map((step, index) => ({ ...step, status: statuses[index] })),
  };
}

async function startNetlifyRollback(request) {
  const revision = String(request.inputs?.target_revision || request.revision);
  const site = await currentSite(request);
  if (site?.published_deploy?.commit_ref === revision) return rollbackSnapshot(request, site.published_deploy);
  const deploy = (await listDeploys(request)).find((candidate) => candidate?.commit_ref === revision && candidate?.state !== "error");
  if (!deploy) {
    return {
      state: "failed",
      detail: `Netlify has no retained deploy for revision ${revision.slice(0, 12)}.`,
      steps: targetSteps(request).map((step, index) => ({ ...step, status: index === 0 ? "failed" : "pending" })),
    };
  }
  const restored = await netlify(`/sites/${encodeURIComponent(siteId(request.target))}/deploys/${encodeURIComponent(deploy.id)}/restore`, { method: "POST" });
  return rollbackSnapshot(request, restored || deploy);
}

async function statusNetlifyRollback(request) {
  const parsed = parseExternalId(request.external_id);
  const revision = String(request.inputs?.target_revision || request.revision);
  const site = await currentSite(request);
  const deploy = site?.published_deploy?.commit_ref === revision
    ? site.published_deploy
    : parsed?.deployId
      ? await netlify(`/deploys/${encodeURIComponent(parsed.deployId)}`)
      : (await listDeploys(request)).find((candidate) => candidate?.commit_ref === revision);
  if (!deploy) return { state: "unknown", detail: "The Netlify restore is not visible yet.", steps: targetSteps(request) };
  return rollbackSnapshot(request, deploy);
}

async function observeNetlify(request) {
  const origin = productionOrigin(request.target);
  const started = Date.now() / 1000;
  try {
    const [site, probeResults] = await Promise.all([
      currentSite(request, { authenticated: false }),
      Promise.allSettled(Array.from({ length: 5 }, () => liveProbe(origin))),
    ]);
    const probes = probeResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const successful = probes.filter((probe) => probe.ok);
    const latencies = successful.map((probe) => probe.latencyMs).sort((left, right) => left - right);
    const representative = successful.at(-1) || probes.at(-1);
    const deploy = site?.published_deploy;
    const allHealthy = deploy?.state === "ready" && successful.length === probeResults.length;
    const status = allHealthy ? "healthy" : successful.length ? "degraded" : "down";
    return {
      status,
      detail: allHealthy
        ? `Five production probes answered HTTP ${representative.status}; Netlify deploy ${String(deploy.id).slice(0, 12)} is ready.`
        : `${successful.length} of 5 production probes succeeded; Netlify reports ${deploy?.state || "no published deploy"}.`,
      metrics: {
        ...(latencies.length ? {
          latency_p50_ms: latencies[Math.floor((latencies.length - 1) * 0.5)],
          latency_p95_ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
        } : {}),
      },
      captured_at: started,
    };
  } catch (error) {
    return { status: "down", detail: cleanText(error.message), captured_at: started };
  }
}

async function handle(request) {
  if (request.operation === "inspect") return { state: "queued", steps: targetSteps(request) };
  if (request.operation === "metrics") return observeNetlify(request);

  if (request.target.kind === "command") {
    if (request.operation === "start") return runCommands(request);
    if (request.operation === "cancel") return { state: "cancelled", external_id: request.external_id, steps: targetSteps(request) };
    return { state: "unknown", detail: "This local command did not leave an external run to reconcile.", steps: targetSteps(request) };
  }

  if (request.target.kind === "netlify-deploy") {
    if (request.operation === "start") return startNetlifyDeploy(request);
    if (["status", "reconcile", "logs"].includes(request.operation)) return statusNetlifyDeploy(request);
    if (request.operation === "cancel") return cancelNetlifyDeploy(request);
  }

  if (request.target.kind === "netlify-rollback") {
    if (request.operation === "start") return startNetlifyRollback(request);
    if (["status", "reconcile", "logs"].includes(request.operation)) return statusNetlifyRollback(request);
    if (request.operation === "cancel") return { state: "cancelled", external_id: request.external_id, steps: targetSteps(request) };
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
