import type { ServerResponse } from "node:http";

import type { GatewayClient } from "../openclaw/gateway-client.js";
import { sendJson } from "./util.js";

export function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, { ok: true, service: "agent-core", role: "vessel" });
}

export function handleReady(res: ServerResponse, gateway: GatewayClient): void {
  if (gateway.isReady()) {
    sendJson(res, 200, { ok: true, gateway: "ready" });
  } else {
    sendJson(res, 503, { ok: false, gateway: "not-ready" });
  }
}
