import {
  WEB_ATTACHMENT_MAX_FILES,
  WEB_ATTACHMENT_MAX_FILE_BYTES,
  WEB_ATTACHMENT_MAX_TOTAL_BYTES,
  isWebImageMimeType
} from "../../../src/web/protocol-limits";
import { createClientId } from "./id";

export interface ComposerDraftStore {
  loadText(threadId: string): string;
  saveText(threadId: string, text: string): void;
  loadAttachments(threadId: string): Promise<File[]>;
  saveAttachments(threadId: string, files: readonly File[]): Promise<void>;
}

type TextDraft = { threadId: string; text: string; savedAt: number };
type StoredAttachment = { name: string; type: string; lastModified: number; blob: Blob };
type AttachmentDraft = { key: string; savedAt: number; files: StoredAttachment[] };

const TAB_KEY = "codex-bridge:composer-tab:v1";
const TEXT_KEY = "codex-bridge:composer-text:v1";
const DATABASE_NAME = "codex-bridge-web";
const ATTACHMENT_STORE = "composer-attachments-v1";
const MAX_TEXT_DRAFTS = 20;
const MAX_ATTACHMENT_DRAFTS = 50;
const TTL = 7 * 24 * 60 * 60 * 1000;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Tab-scoped composer state. It is optional and never carries credentials or permissions. */
export class LocalComposerDraftStore implements ComposerDraftStore {
  private readonly tabId: string;
  private database?: Promise<IDBDatabase | null>;

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly indexedDb?: Pick<IDBFactory, "open">, private readonly now: () => number = Date.now,
    createId: () => string = createClientId) {
    let tabId = "";
    try { tabId = storage.getItem(TAB_KEY) ?? ""; } catch { /* Browser storage is optional. */ }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tabId)) {
      tabId = createId();
      try { storage.setItem(TAB_KEY, tabId); } catch { /* Browser storage is optional. */ }
    }
    this.tabId = tabId;
  }

  private readTextDrafts(): TextDraft[] {
    let parsed: unknown;
    try {
      const raw = this.storage.getItem(TEXT_KEY);
      if (!raw) return [];
      parsed = JSON.parse(raw);
    } catch {
      try { this.storage.removeItem(TEXT_KEY); } catch { /* Browser storage is optional. */ }
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value: Partial<TextDraft>) => {
      if (!value || typeof value.threadId !== "string" || value.threadId.length > 200 ||
          typeof value.text !== "string" || value.text.length > 6000 || typeof value.savedAt !== "number" ||
          !Number.isFinite(value.savedAt) || value.savedAt > this.now() || this.now() - value.savedAt > TTL) return [];
      return [{ threadId: value.threadId, text: value.text, savedAt: value.savedAt }];
    }).slice(-MAX_TEXT_DRAFTS);
  }

  loadText(threadId: string): string {
    try {
      const drafts = this.readTextDrafts();
      this.storage.setItem(TEXT_KEY, JSON.stringify(drafts));
      return drafts.find((draft) => draft.threadId === threadId)?.text ?? "";
    } catch { return ""; }
  }

  saveText(threadId: string, text: string): void {
    try {
      const drafts = this.readTextDrafts().filter((draft) => draft.threadId !== threadId);
      if (text) drafts.push({ threadId: threadId.slice(0, 200), text: text.slice(0, 6000), savedAt: this.now() });
      this.storage.setItem(TEXT_KEY, JSON.stringify(drafts.slice(-MAX_TEXT_DRAFTS)));
    } catch { /* A full or disabled store must not block the composer. */ }
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (!this.indexedDb) return Promise.resolve(null);
    if (!this.database) this.database = new Promise((resolve) => {
      const request = this.indexedDb!.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(ATTACHMENT_STORE))
          request.result.createObjectStore(ATTACHMENT_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.database;
  }

  private attachmentKey(threadId: string): string { return JSON.stringify([this.tabId, threadId]); }

  private async pruneAttachments(database: IDBDatabase): Promise<void> {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(ATTACHMENT_STORE, "readwrite");
      const store = transaction.objectStore(ATTACHMENT_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        const records = (request.result as Partial<AttachmentDraft>[]).filter((record) =>
          typeof record.key === "string" && typeof record.savedAt === "number");
        const retained = records.filter((record) => record.savedAt! <= this.now() && this.now() - record.savedAt! <= TTL)
          .sort((a, b) => b.savedAt! - a.savedAt!).slice(0, MAX_ATTACHMENT_DRAFTS);
        const keys = new Set(retained.map((record) => record.key));
        for (const record of records) if (record.key && !keys.has(record.key)) store.delete(record.key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => resolve();
    });
  }

  async loadAttachments(threadId: string): Promise<File[]> {
    try {
      const database = await this.openDatabase();
      if (!database) return [];
      await this.pruneAttachments(database);
      const transaction = database.transaction(ATTACHMENT_STORE, "readonly");
      const record = await requestResult(transaction.objectStore(ATTACHMENT_STORE)
        .get(this.attachmentKey(threadId)) as IDBRequest<AttachmentDraft | undefined>);
      if (!record || !Array.isArray(record.files) || record.files.length > WEB_ATTACHMENT_MAX_FILES) return [];
      const files = record.files.flatMap((value) => {
        if (!value || typeof value.name !== "string" || value.name.length > 200 ||
            !isWebImageMimeType(value.type) || !(value.blob instanceof Blob) || value.blob.size < 1 ||
            value.blob.size > WEB_ATTACHMENT_MAX_FILE_BYTES || !Number.isFinite(value.lastModified)) return [];
        return [new File([value.blob], value.name, { type: value.type, lastModified: value.lastModified })];
      });
      if (files.length !== record.files.length || files.reduce((sum, file) => sum + file.size, 0) > WEB_ATTACHMENT_MAX_TOTAL_BYTES) {
        await this.saveAttachments(threadId, []); return [];
      }
      return files;
    } catch { return []; }
  }

  async saveAttachments(threadId: string, files: readonly File[]): Promise<void> {
    try {
      const database = await this.openDatabase();
      if (!database) return;
      const transaction = database.transaction(ATTACHMENT_STORE, "readwrite");
      const store = transaction.objectStore(ATTACHMENT_STORE);
      const key = this.attachmentKey(threadId);
      if (!files.length) store.delete(key);
      else store.put({ key, savedAt: this.now(), files: files.map((file) => ({ name: file.name.slice(0, 200),
        type: file.type, lastModified: file.lastModified, blob: file.slice(0, file.size, file.type) })) } satisfies AttachmentDraft);
      await new Promise<void>((resolve) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => resolve();
      });
      await this.pruneAttachments(database);
    } catch { /* A full or disabled store must not block the composer. */ }
  }
}
