/**
 * Metrics (BUILD_PLAN section 15) on Workers Analytics Engine. The binding is optional: with no
 * METRICS binding (local, tests) every call is a no-op. Never put agent-written text in a blob.
 */
export type Metrics = AnalyticsEngineDataset | undefined;

export type MetricEvent =
  | "request"
  | "signature_failure"
  | "registration"
  | "pulse"
  | "scan_flag"
  | "credential_rejected"
  | "quarantine"
  | "item_hidden"
  | "task_transition"
  | "kudos"
  | "standing_run"
  | "classified"
  | "proposal"
  | "webhook"
  | "live_connect"
  | "budget";

export function emit(
  metrics: Metrics,
  event: MetricEvent,
  blobs: string[] = [],
  doubles: number[] = [],
): void {
  try {
    metrics?.writeDataPoint({ indexes: [event], blobs: [event, ...blobs], doubles });
  } catch {
    // Metrics must never break a request.
  }
}
