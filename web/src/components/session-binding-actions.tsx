import type { SessionControls } from "../lib/session-controls";
import { Button } from "./ui/button";

export type SessionBindingActionsProps = {
  controls: SessionControls;
  onBind: (action: "request" | "cancel") => void;
};

export function SessionBindingActions({ controls, onBind }: SessionBindingActionsProps) {
  return <>
    {controls.showBind && <Button disabled={!controls.bindEnabled}
      onClick={() => onBind("request")}>{controls.bindLabel}</Button>}
    {controls.showCancel && <Button variant="outline" disabled={!controls.cancelEnabled}
      onClick={() => onBind("cancel")}>Cancel wait</Button>}
  </>;
}
