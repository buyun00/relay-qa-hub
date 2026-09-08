import { isImportExecutionHeld } from "@relay-qa-hub/storage";
import { join } from "node:path";

/** Shared with the storage worker so API and worker enforce the same restore marker. */
export function importExecutionHeld(dataRoot: string): boolean {
  return isImportExecutionHeld(join(dataRoot, ".qa-hub-import-hold.json"));
}
