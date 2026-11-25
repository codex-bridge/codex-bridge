/** A registration is independent of where its process happens to execute. */
export function mcpRegistrationKey(name: string, environmentId?: string | null): string {
  return JSON.stringify([environmentId ?? null, name]);
}

export function mcpRegistrationLabel(name: string, environmentId?: string | null): string {
  return environmentId ? `${name} [${environmentId}]` : name;
}
