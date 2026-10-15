import type { WorkbenchState } from "../lib/workbench";
import { Button } from "./ui/button";
import { InfoHint } from "./info-hint";

const connectionLabels = {
  idle: "Disconnected", connecting: "Connecting", connected: "Connected",
  offline: "Network offline", revoked: "Connection expired"
};

export type ServiceConnectionControlProps = {
  connection: WorkbenchState["connection"];
  occupied: boolean;
  onConnect: () => void;
};

export function ServiceConnectionControl({ connection, occupied, onConnect }: ServiceConnectionControlProps) {
  const connected = connection === "connected";
  const warning = connection === "offline" || connection === "revoked";
  const status = <div className={`connection-status${connected ? " connection-status-compact" : ""}`}>
    <p role="status" data-tone={warning ? "warning" : "neutral"}>{connectionLabels[connection]}</p>
    <InfoHint text="Connecting to the service grants this browser window access only. It does not claim any session."
      label="Service connection help" />
  </div>;
  if (connected) return status;
  return <div className="connection-expanded">
    {status}
    <Button variant="outline" disabled={connection === "connecting"} onClick={onConnect}>
      {connection === "connecting" ? "Connecting…" : occupied ? "Take over service connection" : "Connect to service"}
    </Button>
  </div>;
}
