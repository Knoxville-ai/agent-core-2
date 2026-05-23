import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson } from "./util.js";

/**
 * Placeholder for /files endpoints (file uploads associated with a
 * conversation). The legacy Python agent owned an attachments directory on
 * disk; in this vessel, file uploads should land in Supabase Storage under
 * a per-conversation prefix and the agent surfaces them via a skill.
 *
 * Returning 501 here is a deliberate signal that this surface is not yet
 * implemented for openclaw vessel agents. The console gracefully renders
 * a "files unavailable" state when the agent responds 501 / 404.
 */
export function handleFilesPlaceholder(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 501, {
    ok: false,
    error: "file attachments not implemented in openclaw vessel yet",
  });
}
