/* global self */
// Notification rendering and click routing only. No push, fetch handler, cache or background SSE.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("message", (event) => {
  if (event.data?.type === "bridge-notification-client" && event.source?.type === "window") {
    event.ports[0]?.postMessage(event.source.id);
  }
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { clientId, threadId } = event.notification.data ?? {};
  if (typeof clientId !== "string" || typeof threadId !== "string") return;
  event.waitUntil((async () => {
    const client = await self.clients.get(clientId);
    if (!client || client.type !== "window") return; // A closed page does not reopen or reconnect.
    await client.focus();
    client.postMessage({ type: "bridge-notification-open", threadId });
  })());
});
