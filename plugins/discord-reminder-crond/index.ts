/*
  discord-reminder-crond

  A Slackbot-like reminder parser for a dedicated Discord channel.

  Key properties:
  - Listens on OpenClaw's gateway hook `message_received`.
  - Only acts on a single Discord channelId.
  - Schedules reminders via native crond (user crontab), NOT OpenClaw cron.
  - Sends reminders back to the same Discord channel via `openclaw message send` CLI.

  NOTE: To ensure messages in the reminder channel do NOT trigger any agent,
  you must deny that channel in OpenClaw config (channels.discord.guilds.<gid>.channels.<cid>.allow=false).
*/

import { execFile as _execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import chrono, { type ParseResult } from "./src/chrono-lite.js";

const execFile = promisify(_execFile);

type PluginApi = {
  id: string;
  pluginConfig: Record<string, unknown> | undefined;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void; debug?: (msg: string) => void };
  on: (hookName: string, handler: (event: GatewayEvent, ctx: unknown) => unknown, opts?: { priority?: number }) => void;
};

type JsonRecord = Record<string, unknown>;

type GatewayEvent = {
  metadata?: JsonRecord;
  content?: unknown;
  from?: unknown;
};

type Reminder = {
  id: string;
  channelId: string;
  createdAt: string;
  createdBy?: string;
  text: string;
  kind: "one-shot" | "recurring";
  // For one-shot
  runAt?: string;
  // For recurring
  cron?: string; // 5-field cron
  source: string;
  // lifecycle (best-effort; older reminders may omit)
  status?: "scheduled" | "completed" | "missed";
  completedAt?: string;
  missedAt?: string;
};

const DATA_DIR = "/home/ec2-user/.openclaw/reminder-crond";
const DB_PATH = path.join(DATA_DIR, "reminders.json");
const RUNNER_PATH = path.join(DATA_DIR, "run-reminder.mjs");
const CRON_LOG_PATH = path.join(DATA_DIR, "cron-exec.log");

function nowIso() {
  return new Date().toISOString();
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadDb(): Promise<{ reminders: Record<string, Reminder> }> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { reminders: {} };
    if (!parsed.reminders || typeof parsed.reminders !== "object") parsed.reminders = {};
    return parsed;
  } catch {
    return { reminders: {} };
  }
}

async function saveDb(db: { reminders: Record<string, Reminder> }) {
  await ensureDataDir();
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + "\n", "utf8");
}

async function markMissedOneShots(db: { reminders: Record<string, Reminder> }, channelId: string) {
  const now = Date.now();
  let changed = false;
  for (const r of Object.values(db.reminders || {})) {
    if (r.channelId !== channelId) continue;
    if (r.kind !== "one-shot") continue;
    if (!r.runAt) continue;
    if (r.status && r.status !== "scheduled") continue;
    const t = new Date(r.runAt).getTime();
    // If it's more than 90s past due, consider it missed.
    if (t < now - 90_000) {
      r.status = "missed";
      r.missedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await saveDb(db);
}

function formatWhenPt(d: Date) {
  // Joshua prefers PT. Native cron is 1-minute resolution, so seconds are misleading.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  // Example: 02/24/2026, 16:48 PST
  return fmt.format(d);
}

function extractDiscordChannelId(metadata: unknown): string | null {
  // Best-effort extraction across provider shapes.
  const record = (metadata && typeof metadata === "object" ? metadata : {}) as JsonRecord;
  const discord = (record.discord && typeof record.discord === "object" ? record.discord : {}) as JsonRecord;
  const candidates: unknown[] = [
    discord.channelId,
    discord.channel_id,
    record.channelId,
    record.channel_id,
    record.chat_id,
    record.chatId,
    record.to,
    record.target,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    // OpenClaw often uses channel:<id>
    const m = s.match(/^(?:channel:)?(\d{17,20})$/);
    if (m) return m[1];
  }
  // Sometimes nested objects
  if (metadata && typeof metadata === "object") {
    for (const [k, v] of Object.entries(metadata)) {
      if (k.toLowerCase().includes("channel") && typeof v === "string") {
        const m = v.match(/(\d{17,20})/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

async function openclawSend(channelId: string, message: string) {
  // Send to a Discord channel via OpenClaw CLI.
  // NOTE: target expects channel:<id>.
  await execFile("openclaw", ["message", "send", "--channel", "discord", "--target", `channel:${channelId}`, "--message", message], {
    timeout: 20000,
  });
}

async function ensureRunnerScript() {
  await ensureDataDir();

  // Always (re)write the runner script. Cron PATH/env issues are subtle, and we want
  // updates to roll out without requiring manual deletion.

  // NOTE: cron jobs run with a very limited PATH. Use an absolute path for openclaw.
  const content = `#!/usr/bin/env node\n\nimport fs from "node:fs/promises";\nimport path from "node:path";\nimport { execFile as _execFile } from "node:child_process";\nimport { promisify } from "node:util";\n\nconst execFile = promisify(_execFile);\n\nconst OPENCLAW_BIN = "/home/ec2-user/.npm-global/bin/openclaw";\n\nconst DATA_DIR = "${DATA_DIR}";\nconst DB_PATH = path.join(DATA_DIR, "reminders.json");\n\nfunction parseArgs(argv) {\n  const out = {};\n  for (let i = 2; i < argv.length; i++) {\n    const a = argv[i];\n    if (a === "--id") out.id = argv[++i];\n  }\n  return out;\n}\n\nasync function loadDb() {\n  try {\n    const raw = await fs.readFile(DB_PATH, "utf8");\n    const j = JSON.parse(raw);\n    if (!j || typeof j !== "object" || !j.reminders) return { reminders: {} };\n    return j;\n  } catch {\n    return { reminders: {} };\n  }\n}\n\nasync function saveDb(db) {\n  await fs.mkdir(DATA_DIR, { recursive: true });\n  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + "\\n", "utf8");\n}\n\nasync function sendDiscord(channelId, message) {\n  await execFile(OPENCLAW_BIN, ["message", "send", "--channel", "discord", "--target", "channel:" + channelId, "--message", message], { timeout: 20000 });\n}\n\nasync function removeCrontabLine(id) {\n  // Remove any line containing our marker for this reminder id.\n  const marker = "openclaw-reminder:" + id;\n  let cur = "";\n  try {\n    const { stdout } = await execFile("crontab", ["-l"], { timeout: 10000 });\n    cur = String(stdout ?? "");\n  } catch {\n    // no crontab\n    cur = "";\n  }\n  const next = cur\n    .split(/\\r?\\n/)\n    .filter((line) => line.trim() && !line.includes(marker))\n    .join("\\n") + "\\n";\n\n  // If next is empty or only whitespace, still install an empty crontab (clears).\n  await execFile("crontab", ["-"], { input: next, timeout: 10000 });\n}\n\nasync function main() {\n  const { id } = parseArgs(process.argv);\n  if (!id) process.exit(2);\n\n  const db = await loadDb();\n  const r = db.reminders?.[id];\n  if (!r) {\n    // Nothing to do; clean stale crontab line if any.\n    await removeCrontabLine(id).catch(() => {});\n    return;\n  }\n\n  await sendDiscord(r.channelId, "⏰ Reminder: " + r.text);\n\n  if (r.kind === "one-shot") {\n    delete db.reminders[id];\n    await saveDb(db);\n    await removeCrontabLine(id).catch(() => {});\n  }\n}\n\nmain().catch((err) => {\n  // Cron should not spam; best-effort.\n  console.error(String(err));\n  process.exit(1);\n});\n`;

  await fs.writeFile(RUNNER_PATH, content, { encoding: "utf8", mode: 0o755 });
}

function makeId() {
  return crypto.randomUUID();
}

function toCronFieldsForDate(d: Date): { min: number; hour: number; dom: number; mon: number } {
  return { min: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), mon: d.getUTCMonth() + 1 };
}

function parseRecurring(text: string): { cron: string; cleanedText: string } | null {
  // Limited Slack-like recurring syntax.
  // Examples:
  // - remind me every day at 9am to stand up
  // - remind me to stand up every weekday at 9:30
  // - remind me every monday at 10 to do backups

  const lower = text.toLowerCase();
  if (!lower.includes("every")) return null;

  // Interpret times in PT by default.
  const tz = "America/Los_Angeles";
  const now = new Date();
  const offNow = tzOffsetMs(tz, now);
  const refPtFrame = new Date(now.getTime() + offNow);

  // Extract time using chrono; for recurrence we mostly need time-of-day.
  const results = chrono.parse(text, refPtFrame, { forwardDate: true });
  const timeRes = results.find((r: ParseResult) => {
    const comps = r.start.knownValues;
    return typeof comps.hour === "number" || typeof comps.minute === "number";
  });
  if (!timeRes) return null;

  // Convert parsed PT-frame timestamp to UTC time-of-day.
  const parsedPtFrame = timeRes.start.date();
  const provisionalUtc = new Date(parsedPtFrame.getTime() - offNow);
  const offAtTarget = tzOffsetMs(tz, provisionalUtc);
  const whenUtc = new Date(parsedPtFrame.getTime() - offAtTarget);

  const min = whenUtc.getUTCMinutes();
  const hour = whenUtc.getUTCHours();

  // Determine day-of-week / frequency
  let dow = "*";
  let dom = "*";
  let mon = "*";

  const weekday = /every\s+weekday/.test(lower) || /every\s+week\s*day/.test(lower);
  if (weekday) {
    dow = "1-5";
  } else {
    const dows: Record<string, string> = {
      sunday: "0",
      monday: "1",
      tuesday: "2",
      wednesday: "3",
      thursday: "4",
      friday: "5",
      saturday: "6",
    };
    for (const [name, val] of Object.entries(dows)) {
      if (new RegExp(`every\\s+${name}`).test(lower)) dow = val;
    }

    // every day
    if (/every\s+day/.test(lower) || /every\s+daily/.test(lower)) {
      dow = "*";
    }

    // every month on the 5th
    const mDom = lower.match(/every\s+month\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?/);
    if (mDom) {
      dom = String(Number(mDom[1]));
      dow = "*";
    }
  }

  const cron = `${min} ${hour} ${dom} ${mon} ${dow}`;

  // Remove parsed time text + leading reminder words.
  let cleaned = text;
  cleaned = cleaned.replace(timeRes.text, " ");
  cleaned = cleaned.replace(/\bevery\b/i, " ");
  cleaned = cleaned.replace(/\b(remind)(\s+me)?\b/i, " ");
  cleaned = cleaned.replace(/^\s*to\s+/i, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // If user wrote "... to <task>" keep only task-ish bits.
  cleaned = cleaned.replace(/^.*\bto\b\s+/i, "");

  if (!cleaned) cleaned = "(no text)";
  return { cron, cleanedText: cleaned };
}

function tzOffsetMs(timeZone: string, date: Date): number {
  // Returns (timeZone wall-clock expressed as UTC) - (actual UTC)
  // e.g. for America/Los_Angeles at UTC 15:00, wall-clock is 07:00 -> offset = -8h
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function parseOneShot(
  text: string,
): { runAt: Date; cleanedText: string; isRelative: boolean; hasExplicitSeconds: boolean; hasExplicitTime: boolean } | null {
  // Interpret times in PT by default.
  const tz = "America/Los_Angeles";
  const now = new Date();
  const offNow = tzOffsetMs(tz, now);
  const refPtFrame = new Date(now.getTime() + offNow);

  const results = chrono.parse(text, refPtFrame, { forwardDate: true });
  if (!results.length) return null;

  // Take the first parse as the intended time.
  const r = results[0];
  const parsedPtFrame = r.start.date();

  const lower = text.toLowerCase();
  const isRelative = /\bin\s+\d+\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks)\b/.test(lower);
  const kv = (r.start?.knownValues ?? {}) as Record<string, unknown>;
  const hasExplicitSeconds = typeof kv.second === "number" || /\bsecond(s)?\b/.test(lower);
  const hasExplicitTime = typeof kv.hour === "number" || typeof kv.minute === "number";

  // Absolute date with no time: default to 9:00 AM PT.
  if (!isRelative && !hasExplicitTime) {
    parsedPtFrame.setHours(9, 0, 0, 0);
  }

  // Absolute times: if user didn't specify seconds, seconds should default to :00.
  if (!isRelative && !hasExplicitSeconds) {
    parsedPtFrame.setSeconds(0, 0);
  }

  // Convert the parsed "PT frame" timestamp back to real UTC, using an offset at the target time
  // (helps around DST boundaries).
  const provisionalUtc = new Date(parsedPtFrame.getTime() - offNow);
  const offAtTarget = tzOffsetMs(tz, provisionalUtc);
  const runAt = new Date(parsedPtFrame.getTime() - offAtTarget);

  let cleaned = text;
  cleaned = cleaned.replace(r.text, " ");
  cleaned = cleaned.replace(/\b(remind)(\s+me)?\b/i, " ");
  cleaned = cleaned.replace(/^\s*to\s+/i, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^.*\bto\b\s+/i, "");
  if (!cleaned) cleaned = "(no text)";

  return { runAt, cleanedText: cleaned, isRelative, hasExplicitSeconds, hasExplicitTime };
}

async function getCrontab(): Promise<string> {
  try {
    const { stdout } = await execFile("crontab", ["-l"], { timeout: 10000 });
    return String(stdout ?? "");
  } catch {
    return "";
  }
}

async function setCrontab(content: string) {
  // child_process.execFile does not reliably support stdin piping in async mode across Node versions.
  // Use spawn and write to stdin.
  await new Promise<void>((resolve, reject) => {
    const p = spawn("crontab", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += String(c)));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`crontab - failed (code=${code}) ${stderr}`.trim()));
    });
    p.stdin.write(content);
    p.stdin.end();
  });
}

async function addCronLine(line: string) {
  const cur = await getCrontab();
  const next = (cur.trimEnd() + "\n" + line.trim() + "\n").replace(/^\n+/, "");
  await setCrontab(next);
}

async function removeCronLinesByPrefix(prefix: string) {
  const cur = await getCrontab();
  const next =
    cur
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.includes(prefix))
      .join("\n") + "\n";
  await setCrontab(next);
}

function listMode(content: string): "none" | "active" | "all" {
  const s = content.trim().toLowerCase();
  if (s === "list reminders") return "active";
  if (s === "list all reminders") return "all";
  return "none";
}

function parseCancelId(content: string): string | null {
  // cancel reminder :<id>
  const m = content.trim().match(/^cancel\s+reminder\s+:?([0-9a-fA-F-]{10,})$/i);
  return m ? m[1] : null;
}

function isGatewayRuntime(): boolean {
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function register(api: PluginApi) {
  if (!isGatewayRuntime()) return;
  const cfg = api.pluginConfig ?? {};
  const enabled = cfg.enabled !== false;
  const channelId = String(cfg.channelId ?? "").trim();

  if (!enabled) {
    api.logger.info?.(`[discord-reminder-crond] disabled`);
    return;
  }

  api.on(
    "gateway_start",
    async () => {
      await ensureRunnerScript().catch((err) => {
        api.logger.warn?.(`[discord-reminder-crond] failed to ensure runner script: ${String(err)}`);
      });
    },
    { priority: 50 },
  );

  api.on(
    "message_received",
    async (event: GatewayEvent) => {
      try {
        if (!channelId) return;
        const meta = (event?.metadata ?? {}) as JsonRecord;
        const gotChannelId = extractDiscordChannelId(meta);
        if (gotChannelId !== channelId) {
          // debug: log discord messages where we couldn't match channel id
          const prov = String(meta?.provider ?? "");
          if (prov.toLowerCase() === "discord") {
            api.logger.debug?.(
              `[discord-reminder-crond] ignoring discord message (expected channelId=${channelId}, got=${gotChannelId ?? "(null)"}) meta.to=${String(meta?.to ?? "")}`,
            );
          }
          return;
        }

        const content = String(event?.content ?? "").trim();
        if (!content) return;

        // management commands
        const lm = listMode(content);
        if (lm !== "none") {
          const db = await loadDb();
          await markMissedOneShots(db, channelId);

          const items = Object.values(db.reminders || {})
            .filter((r) => r.channelId === channelId)
            .filter((r) => {
              if (lm === "all") return true;
              // active list: scheduled only
              return (r.status ?? "scheduled") === "scheduled";
            });

          if (!items.length) {
            await openclawSend(channelId, lm === "all" ? "No reminders." : "No active reminders.");
            return;
          }

          const lines = items
            .sort((a, b) => String(a.runAt ?? "").localeCompare(String(b.runAt ?? "")))
            .slice(0, 30)
            .map((r) => {
              const when = r.kind === "one-shot" ? formatWhenPt(new Date(r.runAt!)) : `cron(${r.cron})`;
              const status = r.status ?? "scheduled";
              const decorated = status === "scheduled" ? r.text : `~~${r.text}~~`;
              const suffix = status === "missed" ? " (missed)" : status === "completed" ? " (done)" : "";
              return `• ${r.id} — ${when} — ${decorated}${suffix}`;
            });
          await openclawSend(channelId, `Reminders (max 30):\n${lines.join("\n")}`);
          return;
        }

        const cancelId = parseCancelId(content);
        if (cancelId) {
          const db = await loadDb();
          if (!db.reminders?.[cancelId]) {
            await openclawSend(channelId, `No reminder found with id ${cancelId}`);
            return;
          }
          delete db.reminders[cancelId];
          await saveDb(db);
          await removeCronLinesByPrefix(`openclaw-reminder:${cancelId}`).catch(() => {});
          await openclawSend(channelId, `Canceled reminder ${cancelId}.`);
          return;
        }

        // Reminders: everything that starts with "remind" should be parsed.
        // Non-reminder chatter in this channel should be ignored (no help spam).
        if (!/^remind\b/i.test(content)) {
          return;
        }

        const db = await loadDb();

        // Recurring
        const rec = parseRecurring(content);
        if (rec) {
          const id = makeId();
          const r: Reminder = {
            id,
            channelId,
            createdAt: nowIso(),
            createdBy: String(event?.from ?? ""),
            text: rec.cleanedText,
            kind: "recurring",
            cron: rec.cron,
            source: content,
            status: "scheduled",
          };
          db.reminders[id] = r;
          await saveDb(db);

          const marker = "openclaw-reminder:" + id;
          const cronLine = `${rec.cron} /usr/bin/node ${RUNNER_PATH} --id ${id} >> ${CRON_LOG_PATH} 2>&1 # ${marker}`;
          await addCronLine(cronLine);

          await openclawSend(channelId, `Okay — I’ll remind here on schedule (id ${id}).\n• cron: ${rec.cron}\n• text: ${r.text}`);
          return;
        }

        // One-shot
        const one = parseOneShot(content);
        if (!one) {
          await openclawSend(channelId, "Sorry — I couldn’t parse a time. Try e.g. `remind me to stand up in 20 minutes` or `remind me tomorrow at 9am to stand up`." );
          return;
        }

        // Native cron is 1-minute resolution.
        // Semantics:
        //  - Absolute times default seconds to :00 (handled in parseOneShot).
        //  - Relative times preserve seconds (handled in parseOneShot).
        //  - Then round to the nearest cron minute boundary.
        const now = new Date();
        let runAt = new Date(one.runAt.getTime());

        const sec = runAt.getUTCSeconds();
        const ms = runAt.getUTCMilliseconds();
        if (sec !== 0 || ms !== 0) {
          if (sec < 30) {
            // round down
            runAt.setUTCSeconds(0, 0);
          } else {
            // round up
            runAt.setUTCSeconds(0, 0);
            runAt = new Date(runAt.getTime() + 60 * 1000);
          }
        }

        // Ensure scheduled time is strictly in the future (avoid missed-tick installs).
        if (runAt.getTime() <= now.getTime()) {
          runAt = new Date(now.getTime());
          runAt.setUTCSeconds(0, 0);
          runAt = new Date(runAt.getTime() + 60 * 1000);
        }

        const id = makeId();
        const fields = toCronFieldsForDate(runAt);
        const cron = `${fields.min} ${fields.hour} ${fields.dom} ${fields.mon} *`;

        const r: Reminder = {
          id,
          channelId,
          createdAt: nowIso(),
          createdBy: String(event?.from ?? ""),
          text: one.cleanedText,
          kind: "one-shot",
          runAt: runAt.toISOString(),
          source: content,
          status: "scheduled",
        };
        db.reminders[id] = r;
        await saveDb(db);

        const marker = "openclaw-reminder:" + id;
        const cronLine = `${cron} /usr/bin/node ${RUNNER_PATH} --id ${id} >> ${CRON_LOG_PATH} 2>&1 # ${marker}`;
        await addCronLine(cronLine);

        await openclawSend(channelId, `Okay — I’ll remind here at ${formatWhenPt(runAt)} (id ${id}): ${r.text}`);
      } catch (err) {
        api.logger.warn?.(`[discord-reminder-crond] message_received handler failed: ${String(err)}`);
      }
    },
    { priority: 50 },
  );

  api.logger.info?.(`[discord-reminder-crond] loaded (channelId=${channelId || "(unset)"})`);
}
