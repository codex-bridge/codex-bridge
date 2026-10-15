import type { DirectoryReceipt } from "./protocol";
import type { WorkbenchController } from "./workbench";

type CatalogController = Pick<WorkbenchController,
  "refresh" | "select" | "addDirectory" | "createSession" | "manageSession">;

export type CatalogActions = {
  refresh: () => Promise<void>;
  select: (threadId: string) => void;
  addDirectory: (path: string) => Promise<DirectoryReceipt | null>;
  createSession: CatalogController["createSession"];
  manageSession: CatalogController["manageSession"];
};

export function createCatalogActions(controller: CatalogController): CatalogActions {
  return {
    refresh: () => controller.refresh(),
    select: (threadId) => controller.select(threadId),
    addDirectory: (path) => controller.addDirectory(path),
    createSession: (directory) => controller.createSession(directory),
    manageSession: (session, action, name) => controller.manageSession(session, action, name)
  };
}
