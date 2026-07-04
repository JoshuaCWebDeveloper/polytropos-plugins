import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readChannelOverlayText } from "./index.js";

test("reads direct regular files in alphabetical filename order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "channel-overlay-test-"));
  const channelDir = path.join(root, "channel-123");

  await fs.mkdir(channelDir);
  await fs.writeFile(path.join(channelDir, "20-second.md"), "second\n");
  await fs.writeFile(path.join(channelDir, "10-first.md"), "\nfirst\n");
  await fs.writeFile(path.join(channelDir, "30-empty.md"), "\n  \n");
  await fs.mkdir(path.join(channelDir, "15-subdir.md"));

  assert.equal(readChannelOverlayText(root, "123"), "first\n\nsecond");
});

test("returns null when a channel directory has no non-empty regular files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "channel-overlay-test-"));
  const channelDir = path.join(root, "channel-456");

  await fs.mkdir(channelDir);
  await fs.writeFile(path.join(channelDir, "empty.md"), "");
  await fs.mkdir(path.join(channelDir, "nested"));

  assert.equal(readChannelOverlayText(root, "456"), null);
});
