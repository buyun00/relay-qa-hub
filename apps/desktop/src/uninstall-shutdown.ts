export const QA_HUB_UNINSTALL_SHUTDOWN_ARGUMENT = "--qa-hub-uninstall-shutdown";

export function isUninstallShutdownRequest(args: readonly unknown[]): boolean {
  return args.some((value) => value === QA_HUB_UNINSTALL_SHUTDOWN_ARGUMENT);
}
