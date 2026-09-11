import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

/** Windows readers can briefly deny replacing a file. Retry the same prepared
 * snapshot, never the Jenkins POST, and retain the previous file until rename. */
export async function writeCompatibilityState(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        return;
      } catch (error) {
        if (
          attempt >= 5 ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")
        )
          throw error;
        await setTimeout(50 * 2 ** attempt);
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
