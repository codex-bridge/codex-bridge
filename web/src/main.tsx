import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App, createWorkbench } from "./app";

const controller = createWorkbench();
createRoot(document.getElementById("root")!).render(<App controller={controller} />);
window.addEventListener("pagehide", () => controller.dispose(), { once: true });
// A back/forward-cache restore must not reuse a disposed connection controller.
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
