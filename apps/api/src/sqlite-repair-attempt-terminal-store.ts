import type { SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { CreateAfterLegacyCommand, TerminalAttemptStore } from "./repair-attempt-terminal.js";

function withoutGm<T extends { readonly isGm: boolean }>(command: T): Omit<T, "isGm"> {
  const input = { ...command };
  Reflect.deleteProperty(input, "isGm");
  return input;
}

export function createSqliteRepairAttemptTerminalStore(options: {
  readonly worker: SqliteStorageWorker;
}): TerminalAttemptStore {
  return {
    execute(command) {
      return options.worker.terminateRepairAttempt(withoutGm(command));
    },
    createAfterLegacy(command: CreateAfterLegacyCommand) {
      return options.worker.createRepairAttemptAfterLegacySupersede(withoutGm(command));
    },
  };
}
