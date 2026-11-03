// STUB. C-003 replaces this with the reserve / release / clear-feedback routes.
// Contract: return null for every path this module does not own, so the router answers 404.
import type { PanelEnv } from "./types.ts";

export async function handlePanelAction(
  _req: Request,
  _env: PanelEnv,
  _ctx: ExecutionContext,
  _path: string,
): Promise<Response | null> {
  return null;
}
