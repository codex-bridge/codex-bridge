import type { WorkbenchState } from "./workbench";

export const connectionLabels: Record<WorkbenchState["connection"], string> = {
  idle: "Disconnected", connecting: "Connecting", connected: "Connected",
  offline: "Network offline", revoked: "Connection expired"
};
