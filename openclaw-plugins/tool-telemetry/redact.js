/**
 * Pure, dependency-free helpers for the tool-telemetry plugin. Kept separate
 * from `index.js` so they can be unit-tested without loading the OpenClaw SDK.
 *
 * The plugin observes every tool call the agent makes and forwards a small,
 * REDACTED description of it to the shim (see index.js). Redaction happens HERE,
 * inside the gateway process, BEFORE anything crosses even the loopback route —
 * so a secret never leaves the process boundary in the first place.
 *
 * This matters because tool params routinely carry secrets:
 *   - the `exec` tool's `params.env` receives platform-brokered delegated
 *     credentials (the delegated-credentials plugin injects them at
 *     `before_tool_call`, see openclaw-plugins/delegated-credentials) — API keys
 *     for whichever vendor the caller shared;
 *   - an operator-configured MCP server call may pass a `headers.Authorization`
 *     or an `api_key` argument;
 *   - a skill may take a password / token as a named argument.
 *
 * The rule is therefore default-deny on anything that looks credential-shaped,
 * plus hard bounds on size so a huge argument (a base64 blob, a pasted file)
 * cannot bloat the row. The result is a JSON-serializable preview meant for a
 * human reading an audit trail — NOT a faithful copy of the arguments.
 */

/** A value is redacted when its KEY matches this. Substring match, case-
 *  insensitive: `apiKey`, `X-Api-Key`, `db_password`, `refresh_token`,
 *  `clientSecret`, `authorization`, `privateKey`, … all hit. */
const SENSITIVE_KEY =
  /(pass|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|auth|credential|\bcreds?\b|cookie|bearer|private[-_]?key|signing|signature|session[-_]?key|otp|passphrase)/i;

/** Keys whose ENTIRE value is a credential bag we never want a preview of, only
 *  a shape summary. `env` is the exec tool's environment (brokered creds land
 *  here); `headers` on an MCP/http call commonly carries Authorization. */
const OPAQUE_KEY = /^(env|headers|secrets|credentials)$/i;

const MAX_STRING = 256; // per string value
const MAX_ARRAY = 20; // items kept per array
const MAX_KEYS = 40; // keys kept per object
const MAX_DEPTH = 4; // nesting levels walked
const MAX_JSON_BYTES = 6144; // final serialized cap (~6 KB)

/** The placeholder a redacted scalar is replaced with. Kept generic so the
 *  audit trail says "a value was here and was withheld" without hinting type. */
const REDACTED = "[redacted]";

function truncateString(s) {
  if (s.length <= MAX_STRING) return s;
  return `${s.slice(0, MAX_STRING)}…(+${s.length - MAX_STRING} chars)`;
}

/** Summarize an opaque credential bag ({env}, {headers}) as a NON-secret shape:
 *  how many entries and their key names only — never the values. Knowing that a
 *  turn's exec ran with `SPORTSINC_API_KEY` set (but not its value) is exactly
 *  the audit signal we want. */
function summarizeOpaque(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    return `[redacted: ${keys.length} key${keys.length === 1 ? "" : "s"}${
      keys.length > 0 ? ` (${keys.slice(0, MAX_KEYS).join(", ")})` : ""
    }]`;
  }
  return REDACTED;
}

function redactValue(value, depth) {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string") return truncateString(value);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return `${value}n`;
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;

  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[array]" : "[object]";

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY} items)`);
    return out;
  }

  // Plain object.
  const out = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (OPAQUE_KEY.test(key)) {
      out[key] = summarizeOpaque(value[key]);
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const red = redactValue(value[key], depth + 1);
    if (red !== undefined) out[key] = red;
  }
  if (keys.length > MAX_KEYS) out._truncated = `+${keys.length - MAX_KEYS} keys`;
  return out;
}

/**
 * Build a redacted, bounded preview of a tool call's arguments.
 *
 * Returns a JSON-serializable value (object/array/scalar) safe to persist as
 * `agent_tool_calls.args_preview`, or `null` when there is nothing to show. A
 * non-object top-level params (rare) is wrapped so the column is always an
 * object or null.
 */
export function redactArgs(params) {
  if (params === undefined || params === null) return null;
  let preview;
  if (typeof params === "object") {
    preview = redactValue(params, 0);
  } else {
    preview = { value: redactValue(params, 0) };
  }
  // Final belt-and-suspenders size cap: even with the per-field bounds a
  // pathological payload could add up, so re-check the serialized size and fall
  // back to a shape-only summary rather than store something huge.
  try {
    const json = JSON.stringify(preview);
    if (json && json.length > MAX_JSON_BYTES) {
      if (preview && typeof preview === "object" && !Array.isArray(preview)) {
        return { _truncated: true, keys: Object.keys(preview).slice(0, MAX_KEYS) };
      }
      return { _truncated: true };
    }
  } catch {
    // Circular or otherwise unserializable — return a safe marker.
    return { _unserializable: true };
  }
  return preview;
}

/**
 * The MCP server (or built-in group) a tool belongs to, derived from its name.
 *
 * OpenClaw namespaces an MCP server's tools with a `<server>__<tool>` prefix
 * (e.g. `knoxville_platform__get_my_bundle`, `odoo_production__sales_get_order`)
 * and may also use `.`/`:` separators. A built-in tool (`exec`, `bash`, …) has
 * no separator → returns null. Used only for grouping/reporting; never trusted
 * for auth.
 */
export function serverFromToolName(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  const m = /^([a-zA-Z0-9_.-]+?)(?:__|[.:])/.exec(toolName);
  return m ? m[1] : null;
}

/** Coerce an unknown into a finite non-negative integer, or null. Defensive:
 *  this data crosses the loopback HTTP boundary. */
export function count(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}
