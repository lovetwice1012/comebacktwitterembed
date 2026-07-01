import "server-only";

import path from "node:path";
import { repoRoot } from "@/lib/env";

const nodeRequire = eval("require") as NodeRequire;

export function requireBotModule<T = unknown>(relativePath: string): T {
  return nodeRequire(path.join(repoRoot(), relativePath)) as T;
}
