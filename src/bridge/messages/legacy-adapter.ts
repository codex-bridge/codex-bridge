// COMPATIBILITY(MESSAGE_FACTORY): remove after transports accept spec-only payloads, including chunked delivery.
export { messagePlainText as renderLegacyMessage } from "./content.js";
