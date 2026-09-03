import { describe, expect, it } from "vitest";

import { mutationTargetsManagedUser } from "./UserManagementPage";

describe("user management interaction locking", () => {
  it("locks only the user row currently being changed", () => {
    const sourceUserId = "10000000-0000-4000-8000-000000000101";
    const otherUserId = "10000000-0000-4000-8000-000000000102";

    expect(mutationTargetsManagedUser(`link:${sourceUserId}`, sourceUserId)).toBe(true);
    expect(mutationTargetsManagedUser(`link:${sourceUserId}`, otherUserId)).toBe(false);
    expect(mutationTargetsManagedUser(null, sourceUserId)).toBe(false);
  });
});
