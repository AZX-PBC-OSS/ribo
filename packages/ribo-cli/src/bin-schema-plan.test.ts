import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";

import { schemaFingerprint } from "./inspect/fingerprint.js";
import { buildCliOnce } from "./test-support/build-once.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

vi.setConfig({ testTimeout: 30_000 });

const schemaDocument = {
  type: "object",
  properties: {
    home: {
      type: "object",
      description: "The home being audited.",
      properties: {
        address: { type: "string", description: "Street address." },
        yearBuilt: { type: "number", description: "Year of construction." },
      },
      required: ["address", "yearBuilt"],
    },
    audit: {
      type: "object",
      properties: {
        completed: { type: "boolean", description: "Whether the audit is complete." },
      },
      required: ["completed"],
    },
  },
  required: ["home", "audit"],
};

const initialPieces = [
  {
    name: "Home identity",
    description: "Where the home is and when it was built.",
    key: "home",
    paths: ["home.address", "home.yearBuilt"],
  },
  {
    name: "Audit status",
    description: "Whether the audit is complete.",
    key: "audit",
    paths: ["audit.completed"],
  },
];

const storedPlan: SchemaPlan = {
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: schemaFingerprint(schemaDocument),
  fieldPaths: ["home.address", "home.yearBuilt", "audit.completed"],
  pieces: initialPieces,
  provenance: {
    model: "earlier-stub",
    backend: "openai-compatible",
    createdAt: "2026-10-01T02:03:04.000Z",
  },
};

interface WireBody {
  readonly model: string;
  readonly max_tokens?: number;
  readonly response_format: {
    readonly json_schema: {
      readonly name: string;
      readonly schema: {
        readonly properties: {
          readonly pieces: {
            readonly items: {
              readonly properties: {
                readonly paths: { readonly items: { readonly enum?: readonly string[] } };
              };
            };
          };
        };
      };
    };
  };
}

interface Received {
  readonly body: WireBody;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];
let directory: string;
let schemaPath: string;
let stubDirectory: string;
let stubLog: string;

function replyFor(body: WireBody): string {
  if (body.model === "invalid-model") return "not JSON";
  if (body.response_format.json_schema.name === "ribo_schema_plan_update") {
    const paths =
      body.response_format.json_schema.schema.properties.pieces.items.properties.paths.items.enum ??
      [];
    return JSON.stringify({
      pieces: [
        {
          name: "Home identity",
          description: "Where the home is and when it was built.",
          key: "home",
          paths,
        },
      ],
    });
  }
  return JSON.stringify({ pieces: initialPieces });
}

beforeAll(async () => {
  buildCliOnce();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      received.push({ body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: replyFor(body) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;

  stubDirectory = mkdtempSync(join(tmpdir(), "ribo-schema-plan-bin-"));
  stubLog = join(stubDirectory, "calls.log");
  const source = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  process.stdout.write("stub planner\\n");
  process.exit(Number(process.env.STUB_VERSION_EXIT || "0"));
}
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(JSON.stringify({ pieces: initialPieces }))});
`;
  for (const binary of ["claude", "codex"]) {
    const path = join(stubDirectory, binary);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  }
}, 120_000);

afterAll(async () => {
  rmSync(stubDirectory, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ribo-schema-plan-command-"));
  schemaPath = join(directory, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(schemaDocument));
  received = [];
  rmSync(stubLog, { force: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBin(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Run> {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: directory,
    env: options.env ?? {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: "stub-only",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { status, stdout, stderr };
}

const runPlan = (args: readonly string[], options?: Parameters<typeof runBin>[1]): Promise<Run> =>
  runBin(["schema", "plan", ...args], options);

const requiredFlags = ["--backend", "openai-compatible", "--model", "gpt-4o"] as const;

function writeStoredPlan(): string {
  const path = join(directory, "plan.json");
  writeFileSync(path, `${JSON.stringify(storedPlan, null, 2)}\n`);
  return path;
}

function changedSchema(): unknown {
  const changed = structuredClone(schemaDocument);
  const properties = changed.properties.home.properties as Record<string, unknown>;
  delete properties.yearBuilt;
  properties.nickname = { type: "string", description: "The household's name for the home." };
  changed.properties.home.required = ["address", "nickname"];
  return changed;
}

test("creation emits only the complete artifact on stdout and applies the response cap", async () => {
  const result = await runPlan([
    schemaPath,
    ...requiredFlags,
    "--response-cap",
    "64",
    "--max-spend",
    "1000",
  ]);

  expect(result.status).toBe(0);
  const plan = JSON.parse(result.stdout) as SchemaPlan;
  expect(plan.version).toBe(SCHEMA_PLAN_CONTRACT_VERSION);
  expect(plan.fieldPaths).toEqual(storedPlan.fieldPaths);
  expect(plan.pieces).toEqual(initialPieces);
  expect(plan.provenance.backend).toBe("openai-compatible");
  expect(plan.provenance.model).toBe("gpt-4o");
  expect(result.stdout).not.toContain("spend estimate");
  expect(result.stderr).toContain("spend estimate");
  expect(result.stderr).toContain("review");
  expect(received).toHaveLength(1);
  expect(received[0]?.body.max_tokens).toBe(64);
});

test("creation with --out writes a distinct new file and keeps artifact text off stdout", async () => {
  const out = join(directory, "created.json");
  const result = await runPlan([schemaPath, ...requiredFlags, "--out", out]);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ pieces: initialPieces });
  expect(result.stderr).toContain("review");
  expect(received).toHaveLength(1);
});

test("update to stdout preserves the input bytes and sends exact drift and review diagnostics to stderr", async () => {
  const planPath = writeStoredPlan();
  const original = readFileSync(planPath);
  writeFileSync(schemaPath, JSON.stringify(changedSchema()));

  const result = await runPlan([schemaPath, ...requiredFlags, "--update", planPath]);

  expect(result.status).toBe(0);
  expect(readFileSync(planPath)).toEqual(original);
  const updated = JSON.parse(result.stdout) as SchemaPlan;
  expect(updated.fieldPaths).toEqual(["home.address", "home.nickname", "audit.completed"]);
  expect(updated.pieces[0]?.paths).toEqual(["home.address", "home.nickname"]);
  expect(result.stderr).toContain(
    "schema field membership drift: added [home.nickname]; removed [home.yearBuilt]",
  );
  expect(result.stderr).toContain("review");
  expect(result.stderr).not.toMatch(/in-place|input (?:was )?updated/iu);
  expect(received).toHaveLength(1);
  expect(received[0]?.body.response_format.json_schema.name).toBe("ribo_schema_plan_update");
});

test("update to a distinct --out leaves both inputs unchanged and stdout empty", async () => {
  const planPath = writeStoredPlan();
  const original = readFileSync(planPath);
  const out = join(directory, "next-plan.json");
  writeFileSync(schemaPath, JSON.stringify(changedSchema()));

  const result = await runPlan([schemaPath, ...requiredFlags, "--update", planPath, "--out", out]);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(readFileSync(planPath)).toEqual(original);
  expect((JSON.parse(readFileSync(out, "utf8")) as SchemaPlan).fieldPaths).toContain(
    "home.nickname",
  );
  expect(result.stderr).toContain("review");
});

test("fingerprint-only drift is one note and a zero-call update needs no credential or backend", async () => {
  const planPath = writeStoredPlan();
  const original = readFileSync(planPath);
  const redescribed = structuredClone(schemaDocument);
  redescribed.properties.home.properties.address.description = "A changed description only.";
  writeFileSync(schemaPath, JSON.stringify(redescribed));

  const result = await runPlan(
    [schemaPath, "--backend", "openai-compatible", "--model", "unused", "--update", planPath],
    { env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } },
  );

  expect(result.status).toBe(0);
  expect(received).toHaveLength(0);
  expect(readFileSync(planPath)).toEqual(original);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaFingerprint: schemaFingerprint(redescribed),
    provenance: storedPlan.provenance,
  });
  expect(result.stderr.match(/schema fingerprint drift:/gu)).toHaveLength(1);
  expect(result.stderr).toContain("calls: at most 0");
  expect(result.stderr).not.toContain("OPENAI_API_KEY");
});

test("input-as-output is refused before backend work and never rewrites the plan", async () => {
  const planPath = writeStoredPlan();
  const original = readFileSync(planPath);
  writeFileSync(schemaPath, JSON.stringify(changedSchema()));

  const result = await runPlan(
    [
      schemaPath,
      "--backend",
      "openai-compatible",
      "--model",
      "gpt-4o",
      "--update",
      planPath,
      "--out",
      planPath,
    ],
    { env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } },
  );

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/input.*output|output.*input/iu);
  expect(result.stderr).not.toContain("OPENAI_API_KEY");
  expect(readFileSync(planPath)).toEqual(original);
  expect(received).toHaveLength(0);
  expect(readdirSync(directory).sort()).toEqual(["plan.json", "schema.json"]);
});

test("existing destinations are refused before any model call, for creation or update", async () => {
  const out = join(directory, "existing.json");
  const original = Buffer.from("existing destination bytes\n");
  writeFileSync(out, original);

  const created = await runPlan([schemaPath, ...requiredFlags, "--out", out]);
  expect(created.status).toBe(2);
  expect(created.stdout).toBe("");
  expect(created.stderr).toContain("already exists");
  expect(readFileSync(out)).toEqual(original);
  expect(received).toHaveLength(0);

  const planPath = writeStoredPlan();
  const updated = await runPlan([schemaPath, ...requiredFlags, "--update", planPath, "--out", out]);
  expect(updated.status).toBe(2);
  expect(updated.stdout).toBe("");
  expect(updated.stderr).toContain("already exists");
  expect(readFileSync(out)).toEqual(original);
  expect(received).toHaveLength(0);
  expect(readdirSync(directory).filter((name) => name.includes(".ribo-"))).toEqual([]);
});

test("usage and unsupported capability faults exit 2 without an artifact", async () => {
  const out = join(directory, "usage.json");
  const cases = [
    [schemaPath, "--backend", "openai-compatible"],
    [schemaPath, "--backend", "unknown", "--model", "gpt-4o"],
    [schemaPath, ...requiredFlags, "--response-cap", "0"],
    [schemaPath, ...requiredFlags, "--timeout", "1.5"],
    [schemaPath, ...requiredFlags, "--max-spend", "-1"],
    [schemaPath, ...requiredFlags, "surplus"],
    [schemaPath, "--backend", "claude-cli", "--model", "stub", "--response-cap", "10"],
    [schemaPath, ...requiredFlags, "--timeout", "1"],
  ];

  for (const args of cases) {
    const result = await runPlan([...args, "--out", out]);
    expect(result.status, args.join(" ")).toBe(2);
    expect(result.stdout, args.join(" ")).toBe("");
    expect(existsSync(out), args.join(" ")).toBe(false);
  }
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
});

test("a missing HTTP credential refuses before any request and creates no artifact", async () => {
  const out = join(directory, "credential.json");
  const result = await runPlan([schemaPath, ...requiredFlags, "--out", out], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      OPENAI_BASE_URL: baseUrl,
    },
  });

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("OPENAI_API_KEY");
  expect(result.stderr).toContain(join(directory, ".env.local"));
  expect(received).toHaveLength(0);
  expect(existsSync(out)).toBe(false);
});

test("a shadowing CLI executable passes preflight and authors without a credential", async () => {
  const result = await runPlan(
    [schemaPath, "--backend", "claude-cli", "--model", "claude-haiku-5-5", "--timeout", "2"],
    {
      env: {
        PATH: `${stubDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "",
        STUB_LOG: stubLog,
      },
    },
  );

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    pieces: initialPieces,
    provenance: { backend: "claude-cli", model: "claude-haiku-5-5" },
  });
  const calls = readFileSync(stubLog, "utf8").trim().split("\n");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[0]!)).toEqual(["--version"]);
  expect(JSON.parse(calls[1]!)).toContain("claude-haiku-5-5");
});

test("missing and failing CLI backends exit 2 without an artifact", async () => {
  const emptyPath = mkdtempSync(join(tmpdir(), "ribo-schema-plan-empty-path-"));
  try {
    const missing = await runPlan([schemaPath, "--backend", "claude-cli", "--model", "stub"], {
      env: { PATH: emptyPath, HOME: process.env["HOME"] ?? "" },
    });
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(/claude.*not found|not found.*claude/iu);
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }

  const failing = await runPlan([schemaPath, "--backend", "claude-cli", "--model", "stub"], {
    env: {
      PATH: `${stubDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? "",
      STUB_LOG: stubLog,
      STUB_VERSION_EXIT: "1",
    },
  });
  expect(failing.status).toBe(2);
  expect(failing.stdout).toBe("");
  expect(failing.stderr).toContain("--version");
  expect(readdirSync(directory)).toEqual(["schema.json"]);
});

test("invalid model output exhausts repairs at exit 2 and leaves no artifact", async () => {
  const out = join(directory, "invalid-model.json");
  const result = await runPlan([
    schemaPath,
    "--backend",
    "openai-compatible",
    "--model",
    "invalid-model",
    "--out",
    out,
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("exhausted its validation repairs");
  expect(received).toHaveLength(3);
  expect(existsSync(out)).toBe(false);
});

test("help names only 0/2 and gives the exact usable update command", async () => {
  const result = await runPlan(["--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--update <plan>");
  expect(result.stdout).toContain("--out <file>");
  expect(result.stdout).toContain("--response-cap <n>");
  expect(result.stdout).toContain("--timeout <seconds>");
  expect(result.stdout).toContain("--max-spend <usd>");
  expect(result.stdout).toContain("ribo schema plan ./schema.json --update ./plan.json");
  expect(result.stdout).toMatch(/0\s+the plan was authored/u);
  expect(result.stdout).toMatch(/2\s+the command could not run/u);
  expect(result.stdout).not.toMatch(/^\s*1\s+/mu);
  expect(result.stdout).not.toMatch(/in-place/iu);
});
