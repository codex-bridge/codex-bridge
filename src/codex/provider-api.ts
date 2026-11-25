import { asRecord, firstString } from "./protocol-utils.js";

export type ModelProviderCatalog = { data: Array<{ id: string; name: string }>; defaultProviderId: string; canChangeDefault: boolean };

export class CodexProviderApi {
  constructor(private readonly deps: { connect: () => Promise<void>;
    request: (method: string, params: unknown, options?: {timeoutMs?: number}) => Promise<unknown> }) {}

  async list(): Promise<ModelProviderCatalog> {
    await this.deps.connect();
    const response = asRecord(await this.deps.request("modelProvider/list", {}, { timeoutMs: 5000 }));
    if (!response || !Array.isArray(response.data) || typeof response.defaultProviderId !== "string" || typeof response.canChangeDefault !== "boolean") throw new Error("Invalid provider catalog response.");
    return { defaultProviderId: response.defaultProviderId, canChangeDefault: response.canChangeDefault, data: response.data.flatMap(value => {
      const row = asRecord(value), id = firstString(row?.id);
      return id ? [{ id, name: firstString(row?.name, row?.displayName) ?? id }] : [];
    }) };
  }

  async setDefault(providerId: string, assertCurrent: () => void = () => {}): Promise<void> {
    if (!providerId.trim()) throw new Error("Provider ID is required.");
    const catalog = await this.list();
    if (!catalog.canChangeDefault) throw new Error("Codex does not allow changing the default provider.");
    if (!catalog.data.some(provider => provider.id === providerId)) throw new Error("Provider is not present in the current Codex configuration.");
    assertCurrent();
    await this.deps.request("modelProvider/default/set", { providerId }, { timeoutMs: 5000 });
  }
}
