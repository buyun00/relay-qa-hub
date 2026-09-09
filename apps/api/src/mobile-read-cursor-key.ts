import { createHmac } from "node:crypto";

const MOBILE_READ_CURSOR_KEY_DOMAIN = "relay-qa-hub/mobile-read-cursor-signing-key/v1";

/** Derives a deterministic, domain-separated cursor key from the required API access token. */
export function deriveMobileReadCursorSigningKey(accessToken: string): Uint8Array {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new TypeError("mobile access token must not be empty");
  }
  return Uint8Array.from(
    createHmac("sha256", Buffer.from(accessToken, "utf8"))
      .update(MOBILE_READ_CURSOR_KEY_DOMAIN, "utf8")
      .digest(),
  );
}
