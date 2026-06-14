import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attemptSendCopiedSentinel,
  consumeCopiedSentinelWithRetry,
} from "./index.js";

const guildId = "1465502729383186474";
const channelId = "1465502729383186475";

test("declares startup activation so the gateway imports the service on boot", async () => {
  const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  assert.equal(manifest.activation?.onStartup, true);
});

async function writeSentinel(
  filePath: string,
  overrides: Record<string, unknown> = {},
) {
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      payload: {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "Continue the interrupted task.",
        ...overrides,
      },
    }),
  );
}

test("sends a copied sentinel to its delivery target and consumes it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-resume-test-"));
  const sentinelPath = path.join(root, "sentinel.json");
  const capturePath = path.join(root, "capture.json");
  const scriptPath = path.join(root, "send.sh");

  await writeSentinel(sentinelPath, {
    deliveryContext: { to: `channel:${channelId}` },
    sessionKey: "agent:main:discord:channel:999999999999999999",
  });
  await fs.writeFile(
    scriptPath,
    `node -e 'require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(1)))' "$@"\n`,
  );

  const result = await attemptSendCopiedSentinel(
    {
      copiedSentinelPath: sentinelPath,
      sendScriptPath: scriptPath,
      guildId,
      logger: {},
    },
    "test",
  );

  assert.equal(result, "sent");
  await assert.rejects(fs.access(sentinelPath));
  const args = JSON.parse(await fs.readFile(capturePath, "utf8"));
  assert.deepEqual(args.slice(0, 2), [guildId, channelId]);
  assert.match(args[2], /Gateway successfully restarted/);
  assert.match(args[2], /Continue the interrupted task/);
});

test("retries a transient send failure and falls back to the session channel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-resume-test-"));
  const sentinelPath = path.join(root, "sentinel.json");
  const markerPath = path.join(root, "first-attempt");
  const capturePath = path.join(root, "capture.txt");
  const scriptPath = path.join(root, "send.sh");

  await writeSentinel(sentinelPath, {
    sessionKey: `agent:main:discord:channel:${channelId}`,
  });
  await fs.writeFile(
    scriptPath,
    [
      `if [ ! -e ${JSON.stringify(markerPath)} ]; then`,
      `  touch ${JSON.stringify(markerPath)}`,
      "  exit 1",
      "fi",
      `printf '%s' "$2" > ${JSON.stringify(capturePath)}`,
      "",
    ].join("\n"),
  );

  await consumeCopiedSentinelWithRetry({
    copiedSentinelPath: sentinelPath,
    sendScriptPath: scriptPath,
    guildId,
    logger: {},
    initialDelayMs: 0,
    retryTimeoutMs: 1000,
    retryIntervalMs: 10,
  });

  assert.equal(await fs.readFile(capturePath, "utf8"), channelId);
  await assert.rejects(fs.access(sentinelPath));
});

test("keeps malformed copied sentinels for manual recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-resume-test-"));
  const sentinelPath = path.join(root, "sentinel.json");
  await fs.writeFile(sentinelPath, "{not-json");

  const result = await attemptSendCopiedSentinel(
    {
      copiedSentinelPath: sentinelPath,
      sendScriptPath: "/unused",
      guildId,
      logger: {},
    },
    "test",
  );

  assert.equal(result, "retained");
  assert.equal(await fs.readFile(sentinelPath, "utf8"), "{not-json");
});
