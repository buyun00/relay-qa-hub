import type { PackagingNotice } from "./packaging-monitor";

// Browser permission must be requested from the user's build-button gesture.
// Electron owns its native notifications and needs no browser permission prompt.
export function requestPackagingNotificationPermission(): void {
  if (
    window.qaHubDesktop ||
    !window.isSecureContext ||
    !("Notification" in window) ||
    Notification.permission !== "default"
  )
    return;
  try {
    void Notification.requestPermission().catch(() => undefined);
  } catch {
    // A browser refusing permission must not prevent the build submission.
  }
}

export async function notifyPackagingSystem(
  notice: PackagingNotice,
  onOpen: () => void,
): Promise<boolean> {
  if (window.qaHubDesktop) return (await window.qaHubDesktop.notifyPackaging?.(notice)) ?? false;
  if (
    !window.isSecureContext ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  )
    return false;
  const notification = new Notification(`QA Hub · ${notice.title}`, {
    body: notice.body,
    tag: notice.id,
  });
  notification.onclick = () => {
    window.focus();
    onOpen();
    notification.close();
  };
  return true;
}
