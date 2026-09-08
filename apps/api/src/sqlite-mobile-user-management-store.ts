import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type {
  ManagedProjectUserList,
  MobileUserManagementStore,
} from "./mobile-user-management.js";

interface MutableIdentityDirectory {
  readonly registerLink: (
    source: { readonly id: string; readonly displayName: string },
    canonical: { readonly id: string; readonly displayName: string },
  ) => void;
  readonly removeLink: (sourceUserId: string) => void;
}

export interface SqliteMobileUserManagementStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly protectedUserIds: readonly string[];
  readonly identityDirectory: MutableIdentityDirectory;
  readonly now?: () => Date;
}

export function createSqliteMobileUserManagementStore(
  options: SqliteMobileUserManagementStoreOptions,
): MobileUserManagementStore {
  const protectedUserIds = Object.freeze([...new Set(options.protectedUserIds)]);
  const protectedUserIdSet = new Set(protectedUserIds);
  const now = options.now ?? (() => new Date());

  async function listUsers(
    actorId: string,
    projectId: string,
    limit: number,
  ): Promise<ManagedProjectUserList> {
    const result = await options.worker.listManagedUsers({
      accountId: options.scope.accountId,
      actorId,
      projectId,
      limit,
    });
    return Object.freeze({
      projectId: result.projectId,
      items: Object.freeze(
        result.items.map((user) =>
          Object.freeze({ ...user, protected: protectedUserIdSet.has(user.userId) }),
        ),
      ),
    });
  }

  return {
    async listUsers(query) {
      return listUsers(query.actorId, query.projectId, query.limit);
    },

    async linkUser(command) {
      const users = await listUsers(command.actorId, command.projectId, 500);
      const source = users.items.find((user) => user.userId === command.userId);
      const canonical = users.items.find((user) => user.userId === command.canonicalUserId);
      if (source === undefined || canonical === undefined) {
        throw Object.assign(new Error("managed user was not found"), { code: "NOT_FOUND" });
      }
      const result = await options.worker.linkManagedUser({
        accountId: options.scope.accountId,
        actorId: command.actorId,
        projectId: command.projectId,
        userId: command.userId,
        canonicalUserId: command.canonicalUserId,
        protectedUserIds,
        createdAt: now().toISOString(),
      });
      return result;
    },

    async unlinkUser(command) {
      const result = await options.worker.unlinkManagedUser({
        accountId: options.scope.accountId,
        actorId: command.actorId,
        projectId: command.projectId,
        userId: command.userId,
        protectedUserIds,
        createdAt: now().toISOString(),
      });
      return result;
    },

    async disableUser(command) {
      return options.worker.disableManagedUser({
        accountId: options.scope.accountId,
        actorId: command.actorId,
        projectId: command.projectId,
        userId: command.userId,
        protectedUserIds,
        createdAt: now().toISOString(),
      });
    },
  };
}
