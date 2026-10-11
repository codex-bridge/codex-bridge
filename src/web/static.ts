import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml"
};
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../dist/web-ui/", import.meta.url));

/** Only the built entry and assets are public; never fall back API routes to HTML. */
export async function serveWebAsset(pathname: string, response: ServerResponse, root = DEFAULT_WEB_ROOT): Promise<boolean> {
  if (pathname !== "/" && pathname !== "/index.html" && !pathname.startsWith("/assets/")) return false;
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part.startsWith("."))) return false;
    const base = await realpath(root);
    const file = await realpath(resolve(base, decoded === "/" ? "index.html" : `.${decoded}`));
    if (!file.startsWith(`${base}${sep}`) || !(await stat(file)).isFile()) return false;
    const type = TYPES[extname(file)];
    if (!type) return false;
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer"
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}
