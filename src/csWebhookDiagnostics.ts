import type { CsWebhookRuntime, CsWebhookRuntimeDiagnostics } from "./csWebhookRuntime.js";
import type { CsSourceMode, CsWebhookSource } from "./botSettings.js";

const activeRuntimes = new Map<CsWebhookSource, CsWebhookRuntime>();

export function setCsWebhookRuntime(runtime: CsWebhookRuntime | undefined, source: CsWebhookSource = "mat"): void {
  if (runtime) activeRuntimes.set(source, runtime);
  else activeRuntimes.delete(source);
}

export async function getCsWebhookDiagnostics(source: CsWebhookSource = "mat"): Promise<CsWebhookRuntimeDiagnostics | undefined> {
  return activeRuntimes.get(source)?.getDiagnostics();
}

export function formatCsWebhookSourceStatus(options: {
  configured: boolean;
  featureEnabled: boolean;
  featureLive: boolean;
  mode: CsSourceMode;
  diagnostics?: CsWebhookRuntimeDiagnostics;
}): string {
  if (!options.featureEnabled) return "Av (CS-voice av)";
  if (!options.configured) return "Av (mottaker ikke konfigurert)";
  if (!options.diagnostics?.listening) return "Av (mottaker lytter ikke)";
  const effectiveMode = options.mode === "live" && !options.featureLive ? "preview" : options.mode;
  const modeLabel = effectiveMode === "off" ? "av behandling"
    : effectiveMode === "preview" ? "forhåndsvisning" : "gjør endringer";
  return options.diagnostics.healthCheckOk
    ? `Lytter (${modeLabel})`
    : `Lytter, men healthcheck feiler (${modeLabel})`;
}
