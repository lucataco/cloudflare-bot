import { describe, expect, it } from "vitest";
import { computerUrlLabel } from "../src/computer-session";

describe("computer URL privacy", () => {
  it("keeps a useful path without credentials, query, or capability fragments", () => {
    expect(computerUrlLabel("https://user:password@example.com/account/login?token=secret#capability"))
      .toBe("https://example.com/account/login");
  });

  it.each([null, "not a URL", "javascript:alert(1)", "data:text/plain,secret", "file:///secret"])(
    "does not expose an unsupported URL: %s", value => {
      expect(computerUrlLabel(value)).toBeNull();
    });

  it("preserves the blank page label", () => {
    expect(computerUrlLabel("about:blank")).toBe("about:blank");
  });
});
