import type { CsWebhookRuntime, CsWebhookRuntimeDiagnostics } from "./csWebhookRuntime.js";

let activeRuntime: CsWebhookRuntime | undefined;

export function setCsWebhookRuntime(runtime: CsWebhookRuntime | undefined): void {
  activeRuntime = runtime;
}

export async function getCsWebhookDiagnostics(): Promise<CsWebhookRuntimeDiagnostics | undefined> {
  return activeRuntime?.getDiagnostics();
}
