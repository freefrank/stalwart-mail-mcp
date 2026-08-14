import { describe, it, expect } from "vitest";
import { htmlToText, truncate, fenceUntrusted, BODY_CHAR_LIMIT } from "../src/text.js";
import { buildSearchFilter } from "../src/mcp.js";
import { verifyBearer } from "../src/auth.js";

describe("htmlToText", () => {
  it("strips tags, scripts and styles", () => {
    const html =
      "<html><head><title>x</title><style>p{color:red}</style></head>" +
      "<body><script>alert(1)</script><p>Hello <b>world</b></p><p>Second</p></body></html>";
    expect(htmlToText(html)).toBe("Hello world\nSecond");
  });

  it("decodes entities", () => {
    expect(htmlToText("a &amp; b &lt;c&gt; &#233; &#x4e2d;")).toBe("a & b <c> é 中");
  });

  it("keeps link targets", () => {
    expect(htmlToText('<a href="https://x.example/y">click</a>')).toBe(
      "click (https://x.example/y)",
    );
  });

  it("converts br and collapses blank runs", () => {
    expect(htmlToText("a<br><br><br>b")).toBe("a\n\nb");
  });
});

describe("truncate", () => {
  it("passes short strings through", () => {
    expect(truncate("hi")).toBe("hi");
  });
  it("truncates with a visible marker", () => {
    const long = "x".repeat(BODY_CHAR_LIMIT + 5000);
    const out = truncate(long);
    expect(out).toContain("TRUNCATED");
    expect(out.length).toBeLessThan(long.length);
  });
});

describe("fenceUntrusted", () => {
  it("wraps content in explicit markers", () => {
    const out = fenceUntrusted("hello");
    expect(out).toContain("BEGIN EXTERNAL EMAIL CONTENT");
    expect(out).toContain("hello");
    expect(out).toContain("END EXTERNAL EMAIL CONTENT");
  });
});

describe("buildSearchFilter", () => {
  it("maps all fields to JMAP filter conditions", () => {
    expect(
      buildSearchFilter({
        query: "quarterly report",
        from: "quantum",
        after: "2026-08-01T00:00:00Z",
        before: "2026-08-08",
        has_attachment: true,
        unread_only: true,
        mailboxId: "mb1",
      }),
    ).toEqual({
      text: "quarterly report",
      from: "quantum",
      after: "2026-08-01T00:00:00Z",
      before: "2026-08-08T00:00:00Z",
      hasAttachment: true,
      notKeyword: "$seen",
      inMailbox: "mb1",
    });
  });

  it("omits absent fields", () => {
    expect(buildSearchFilter({})).toEqual({});
    expect(buildSearchFilter({ has_attachment: false })).toEqual({ hasAttachment: false });
  });

  it("rejects invalid dates", () => {
    expect(() => buildSearchFilter({ after: "yesterday-ish" })).toThrow(/ISO 8601/);
  });
});

describe("verifyBearer", () => {
  const token = "sekret-token-0123456789abcdef0123456789abcdef";
  it("accepts the right token", async () => {
    expect(await verifyBearer(`Bearer ${token}`, token)).toBe(true);
  });
  it("rejects a wrong token, missing header, wrong scheme, empty secret", async () => {
    expect(await verifyBearer(`Bearer nope`, token)).toBe(false);
    expect(await verifyBearer(undefined, token)).toBe(false);
    expect(await verifyBearer(`Basic ${token}`, token)).toBe(false);
    expect(await verifyBearer(`Bearer ${token}`, "")).toBe(false);
  });
});
