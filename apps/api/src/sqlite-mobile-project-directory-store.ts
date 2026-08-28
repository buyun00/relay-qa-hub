import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type {
  MobileProjectDirectoryStore,
  MobileProjectMember,
  MobileProjectMemberList,
  MobileProjectRole,
} from "./mobile-project-directory.js";

interface QaIdentityDirectory {
  readonly canonicalize: (identity: { readonly id: string; readonly displayName: string }) => {
    readonly id: string;
    readonly displayName: string;
  };
}

export interface SqliteMobileProjectDirectoryStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly identityDirectory?: QaIdentityDirectory;
}

export function canonicalizeMobileProjectMembers(
  input: MobileProjectMemberList,
  directory: QaIdentityDirectory,
): MobileProjectMemberList {
  const grouped = new Map<
    string,
    {
      readonly userId: string;
      readonly displayName: string;
      readonly roles: Set<MobileProjectRole>;
    }
  >();
  for (const member of input.items) {
    const canonical = directory.canonicalize({
      id: member.userId,
      displayName: member.displayName,
    });
    const current = grouped.get(canonical.id) ?? {
      userId: canonical.id,
      displayName: canonical.displayName,
      roles: new Set<MobileProjectRole>(),
    };
    for (const role of member.roles) current.roles.add(role);
    grouped.set(canonical.id, current);
  }
  const items: readonly MobileProjectMember[] = Object.freeze(
    [...grouped.values()]
      .map((member) =>
        Object.freeze({
          userId: member.userId,
          projectId: input.projectId,
          displayName: member.displayName,
          roles: Object.freeze([...member.roles].sort()),
          active: true as const,
        }),
      )
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName, "zh-CN") ||
          left.userId.localeCompare(right.userId),
      ),
  );
  return Object.freeze({ ...input, items });
}

export function createSqliteMobileProjectDirectoryStore(
  options: SqliteMobileProjectDirectoryStoreOptions,
): MobileProjectDirectoryStore {
  return {
    async listProjects(query) {
      return options.worker.listMobileVisibleProjects({
        accountId: options.scope.accountId,
        actorId: query.actorId,
        limit: query.limit,
      });
    },

    async listMembers(query) {
      const result = await options.worker.listMobileProjectMembers({
        accountId: options.scope.accountId,
        actorId: query.actorId,
        projectId: query.projectId,
        limit: query.limit,
      });
      return options.identityDirectory === undefined
        ? result
        : canonicalizeMobileProjectMembers(result, options.identityDirectory);
    },

    async listModules(query) {
      return options.worker.listMobileProjectModules({
        accountId: options.scope.accountId,
        actorId: query.actorId,
        projectId: query.projectId,
      });
    },
  };
}
