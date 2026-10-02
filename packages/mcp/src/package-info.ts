/** Server name and version advertised over MCP come from package.json. */

import { readFileSync } from "node:fs";

interface PackageInfo {
  name: string;
  version: string;
}

function loadPackageInfo(): PackageInfo {
  // dist/package-info.js and src/package-info.ts both sit one level below the package root.
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>).name !== "string" ||
    typeof (raw as Record<string, unknown>).version !== "string"
  ) {
    throw new Error("package.json must declare name and version");
  }
  const { name, version } = raw as Record<string, string>;
  return { name, version };
}

export const packageInfo: PackageInfo = loadPackageInfo();
