import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  BACKGROUND_PARAMETER_SCHEMA,
  createBackgroundLaunch,
  createSchemaContributions,
  rewriteExecParams,
  shellQuote,
} from "./background.js";

const execFileAsync = promisify(execFile);

test("contributes an optional boolean to the outer exec_command tool", () => {
  assert.deepEqual(createSchemaContributions(), [
    {
      toolName: "exec_command",
      properties: { background: BACKGROUND_PARAMETER_SCHEMA },
    },
  ]);
});

test("shellQuote preserves arbitrary shell source as one argument", async () => {
  const value = "printf '%s\\n' \"hello world\"; echo $HOME";
  const { stdout } = await execFileAsync("/usr/bin/sh", [
    "-c",
    `printf '%s' ${shellQuote(value)}`,
  ]);
  assert.equal(stdout, value);
});

test("builds a fully detached launch wrapper with a reported pid and log", () => {
  const launch = createBackgroundLaunch({
    command: "printf detached",
    logDirectory: "/tmp/background logs",
    launchId: "launch",
  });

  assert.match(launch.command, /\/usr\/bin\/nohup \/usr\/bin\/setsid/);
  assert.match(launch.command, /<\/dev\/null >>"\$log" 2>&1 &/);
  assert.match(launch.command, /background_pid=%s\\nbackground_log=%s\\n/);
  assert.equal(launch.logPath, "/tmp/background logs/launch.log");
});

test("does not alter foreground calls", () => {
  const params = { command: "echo foreground", timeoutMs: 5000 };
  assert.deepEqual(
    rewriteExecParams(params, { logDirectory: "/tmp/logs", launchId: "unused" }),
    { params },
  );
});

test("consumes background and preserves downstream parameters", () => {
  const result = rewriteExecParams(
    {
      command: "sleep 10",
      background: true,
      timeoutMs: 250,
      workdir: "/tmp/work",
    },
    { logDirectory: "/tmp/log dir", launchId: "launch-1" },
  );

  assert.equal(result.params.background, undefined);
  assert.equal(result.params.timeoutMs, 250);
  assert.equal(result.params.workdir, "/tmp/work");
  assert.match(String(result.params.command), /nohup .*setsid/);
  assert.equal(result.launch?.logPath, "/tmp/log dir/launch-1.log");
});

test("supports cmd as the command alias", () => {
  const result = rewriteExecParams(
    { cmd: "sleep 10", background: true },
    { logDirectory: "/tmp/logs", launchId: "cmd-only" },
  );

  assert.equal(result.params.command, undefined);
  assert.match(String(result.params.cmd), /nohup .*setsid/);
});

test("rewrites both aliases when command and cmd conflict", () => {
  const result = rewriteExecParams(
    {
      command: "printf command-wins",
      cmd: "printf stale-foreground-alias",
      background: true,
    },
    { logDirectory: "/tmp/logs", launchId: "conflicting-aliases" },
  );

  assert.equal(result.params.command, result.params.cmd);
  assert.doesNotMatch(String(result.params.command), /stale-foreground-alias/);
  assert.match(String(result.params.command), /printf command-wins/);
});

test("replaces a present non-string alias to prevent downstream precedence changes", () => {
  const result = rewriteExecParams(
    {
      command: "printf selected",
      cmd: ["unexpected", "alias"],
      background: true,
    },
    { logDirectory: "/tmp/logs", launchId: "invalid-alias" },
  );

  assert.equal(result.params.command, result.params.cmd);
  assert.match(String(result.params.cmd), /printf selected/);
});

test("detached launch returns promptly, survives the parent shell, and captures output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "exec-background-test-"));
  const marker = path.join(root, "marker.txt");
  const launch = createBackgroundLaunch({
    command: `sleep 0.2; printf 'done\\n' > ${shellQuote(marker)}; printf 'streamed\\n'`,
    logDirectory: root,
    launchId: "integration",
  });

  const startedAt = Date.now();
  const { stdout } = await execFileAsync("/usr/bin/sh", ["-c", launch.command]);
  assert.ok(Date.now() - startedAt < 1000);
  assert.match(stdout, /^background_pid=\d+\nbackground_log=.+\n$/);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      assert.equal(await fs.readFile(marker, "utf8"), "done\n");
      assert.equal(await fs.readFile(launch.logPath, "utf8"), "streamed\n");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail("detached command did not finish");
});
