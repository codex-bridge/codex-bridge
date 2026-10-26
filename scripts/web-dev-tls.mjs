import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";

// Generates ignored development artifacts only. Never modifies any system trust store.
const host = process.argv[2];
if (!host || !isIP(host)) throw new Error("Usage: node scripts/web-dev-tls.mjs <LAN-IP> [output-directory]");
const directory = resolve(process.argv[3] ?? "workspaces/web-dev-tls");
const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
if (existsSync(cert) || existsSync(key)) throw new Error("TLS files already exist; refusing to overwrite them.");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const result = spawnSync(process.env.OPENSSL_BIN || "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256",
  "-nodes", "-days", "30", "-keyout", key, "-out", cert, "-subj", "/CN=Bridge development",
  "-addext", `subjectAltName=IP:${host}`], { encoding: "utf8" });
if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
chmodSync(key, 0o600);
console.log(`Created development certificate: ${cert}\nPrivate key: ${key}\nThis self-signed certificate is not automatically trusted. No system settings were changed.`);
