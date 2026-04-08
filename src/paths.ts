import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** ~/.agentwake — the fixed home directory for all agentwake data. */
export const AGENTWAKE_HOME = process.env.AGENTWAKE_HOME ?? path.join(os.homedir(), ".agentwake");

/** Root of the installed npm package (where package.json / web/ / .env.example live). */
export const PKG_ROOT = path.resolve(__dirname, "..");

/** Ensure ~/.agentwake exists and return its path. */
export function ensureHome(): string {
  if (!existsSync(AGENTWAKE_HOME)) {
    mkdirSync(AGENTWAKE_HOME, { recursive: true });
  }
  return AGENTWAKE_HOME;
}

/** Resolve a path relative to AGENTWAKE_HOME. */
export function homePath(...segments: string[]): string {
  return path.join(AGENTWAKE_HOME, ...segments);
}
