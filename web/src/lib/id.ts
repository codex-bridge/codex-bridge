/** Non-secret request/window identity; usable on local-network HTTP as well as HTTPS. */
export function createClientId(random: Pick<Crypto, "getRandomValues"> = crypto): string {
  return Array.from(random.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
