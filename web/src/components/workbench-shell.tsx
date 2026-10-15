import type { ReactNode } from "react";

export function WorkbenchShell({ navigation, children }: { navigation: ReactNode; children: ReactNode }) {
  return <main className="workbench">
    {navigation}
    <section className="conversation" aria-label="Conversation">{children}</section>
  </main>;
}
