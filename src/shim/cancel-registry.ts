/**
 * In-process cancel registry: maps an assistant message id to an
 * AbortController. The /interrupt route aborts the controller; the
 * streaming loop in /messages aborts its upstream fetch on the same
 * signal and flips its row to status=interrupted.
 *
 * Equivalent of the threading.Event map in the original Python
 * agent-core (app/messaging/api.py _cancel_events).
 */
export class CancelRegistry {
  private readonly entries = new Map<string, AbortController>();

  register(messageId: string): AbortController {
    const controller = new AbortController();
    this.entries.set(messageId, controller);
    return controller;
  }

  release(messageId: string): void {
    this.entries.delete(messageId);
  }

  signal(messageId: string): boolean {
    const controller = this.entries.get(messageId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
