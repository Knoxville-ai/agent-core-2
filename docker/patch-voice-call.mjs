#!/usr/bin/env node
// Build-time patch for @openclaw/voice-call (pinned in package.json).
//
// In realtime mode the plugin reports what the voice says as a `call.speaking`
// event carrying the text, but its call manager only flips the call's state on
// that event and never adds the text to the call's transcript. The caller's
// side is recorded (`call.speech`), so every call log — and the console record
// src/voice/call-mirror.ts builds from it — had only half the conversation.
// This adds the bot's line to the transcript, skipping it when the same line
// was just recorded (the turn-based path records speech before Telnyx echoes
// it back as `call.speak.started`).
//
// Idempotent (a marker comment), and LOUD: if the code it patches is not found
// — e.g. after a version bump — it exits non-zero and fails the image build,
// rather than silently shipping without the fix.
//
// Usage: node docker/patch-voice-call.mjs [pluginDir]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const MARKER = "/* knox-patch: bot-transcript */";
const NEEDLE = 'case "call.speaking":\n\t\t\ttransitionState(call, "speaking");\n\t\t\tbreak;';
const REPLACEMENT =
  'case "call.speaking":\n' +
  `\t\t\t${MARKER}\n` +
  '\t\t\tif (typeof event.text === "string" && event.text.trim()) {\n' +
  "\t\t\t\tconst knoxLast = call.transcript[call.transcript.length - 1];\n" +
  '\t\t\t\tif (!(knoxLast && knoxLast.speaker === "bot" && knoxLast.text === event.text)) addTranscriptEntry(call, "bot", event.text);\n' +
  "\t\t\t}\n" +
  '\t\t\ttransitionState(call, "speaking");\n' +
  "\t\t\tbreak;";

export function patchSource(src) {
  if (src.includes(MARKER)) return { src, changed: false };
  const count = src.split(NEEDLE).length - 1;
  if (count !== 1) throw new Error(`expected 1 call.speaking handler, found ${count}`);
  return { src: src.replace(NEEDLE, REPLACEMENT), changed: true };
}

export function patchPluginDir(pluginDir) {
  const dist = join(pluginDir, "dist");
  const targets = readdirSync(dist).filter((f) => /^runtime-entry-.*\.js$/.test(f));
  const hits = targets.filter((f) => readFileSync(join(dist, f), "utf8").includes('case "call.speaking":'));
  if (hits.length !== 1) throw new Error(`expected 1 runtime-entry with the handler, found ${hits.length}`);
  const file = join(dist, hits[0]);
  const { src, changed } = patchSource(readFileSync(file, "utf8"));
  if (changed) writeFileSync(file, src);
  return { file, changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir =
    process.argv[2] ?? dirname(createRequire(import.meta.url).resolve("@openclaw/voice-call/package.json"));
  try {
    const { file, changed } = patchPluginDir(dir);
    console.log(`voice-call bot-transcript patch ${changed ? "applied to" : "already in"} ${file}`);
  } catch (err) {
    console.error(`voice-call bot-transcript patch FAILED: ${err.message}`);
    process.exit(1);
  }
}
