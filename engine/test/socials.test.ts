// The creator's links (src/socials.ts, docs/API.md v2.7. Two things are pinned: what passes and what is refused (above all the lookalikes: a
// host that dresses as x.com, t.me or an honest site), and that the server and the launch form (web/src/lib/socials.ts) judge every input the same way.
import { describe, expect, test } from "bun:test";
import * as web from "../../web/src/lib/socials";
import { SOCIAL_MAX_CHARS, checkTelegram, checkWebsite, checkX, parseSocials, readStoredSocials } from "../src/socials";

const ok = (check: { url: string | null; error: string | null }) => check.url;

describe("X", () => {
  test("a handle, a profile link or a link to one of its posts all become the profile address", () => {
    for (const input of ["@snarkspad", "snarkspad", "x.com/snarkspad", "https://x.com/snarkspad", "https://www.x.com/snarkspad", "https://twitter.com/snarkspad/status/1234", "HTTPS://X.COM/snarkspad?s=20"]) {
      expect(ok(checkX(input))).toBe("https://x.com/snarkspad");
    }
    expect(ok(checkX("  @a_B9  "))).toBe("https://x.com/a_B9");
  });

  test("a handle is 1 to 15 letters, digits or underscores", () => {
    expect(ok(checkX("a"))).toBe("https://x.com/a");
    expect(ok(checkX("a".repeat(15)))).toBe(`https://x.com/${"a".repeat(15)}`);
    for (const bad of ["a".repeat(16), "@bad handle", "@ba-d", "@emoji\u{1f600}", "@", "snarks.pad"]) expect(ok(checkX(bad))).toBeNull();
  });

  test("lookalike hosts are not X: the whole host must be x.com, twitter.com or www. of them, over https, with no login in it", () => {
    for (const bad of [
      "https://x.com.evil.example/snarkspad", "https://notx.com/snarkspad", "https://x.com@evil.example/snarkspad", "https://evil.example/x.com/snarkspad",
      "https://x.com:secret@evil.example/snarkspad", "https://xn--x-9ma.com/snarkspad", "https://х.com/snarkspad", "http://x.com/snarkspad",
      "javascript:alert(1)", "data:text/html,x", "https://x.co/snarkspad", "https://twitter.com.evil.example/snarkspad", "https://x.com./snarkspad",
    ]) {
      expect(ok(checkX(bad))).toBeNull();
    }
  });

  test("a link that is longer than 100 characters is refused whatever it points at", () => {
    expect(checkX(`https://x.com/snarkspad?${"a=1&".repeat(40)}`).error).toContain(`${SOCIAL_MAX_CHARS}`);
  });
});

describe("Telegram", () => {
  test("a name, @name or a t.me / telegram.me link becomes the t.me address", () => {
    for (const input of ["@snarkspad", "snarkspad", "t.me/snarkspad", "https://t.me/snarkspad", "https://www.t.me/snarkspad", "https://telegram.me/snarkspad", "https://t.me/snarkspad/123"]) {
      expect(ok(checkTelegram(input))).toBe("https://t.me/snarkspad");
    }
  });

  test("a name is 5 to 32 letters, digits or underscores", () => {
    expect(ok(checkTelegram("a".repeat(5)))).not.toBeNull();
    expect(ok(checkTelegram("a".repeat(32)))).not.toBeNull();
    for (const bad of ["abcd", "a".repeat(33), "@bad name", "@ba-dname"]) expect(ok(checkTelegram(bad))).toBeNull();
  });

  test("lookalike hosts are not Telegram", () => {
    for (const bad of ["https://t.me.evil.example/snarkspad", "https://nott.me/snarkspad", "https://t.me@evil.example/snarkspad", "https://xn--t-9ma.me/snarkspad", "http://t.me/snarkspad", "https://t.co/snarkspad", "https://evil.example/t.me/snarkspad"]) {
      expect(ok(checkTelegram(bad))).toBeNull();
    }
  });
});

describe("website", () => {
  test("a bare domain or an https link is kept as the normalised https address", () => {
    expect(ok(checkWebsite("example.com"))).toBe("https://example.com/");
    expect(ok(checkWebsite("https://Example.com/coin?a=1"))).toBe("https://example.com/coin?a=1");
    expect(ok(checkWebsite("https://sub.example.co.uk/a"))).toBe("https://sub.example.co.uk/a");
  });

  test("only https, only a real-looking name, no login, nothing that belongs in the X or Telegram field", () => {
    for (const bad of [
      "http://example.com", "ftp://example.com", "javascript:alert(1)", "https://localhost", "https://127.0.0.1", "https://exa mple.com", "https://user:pass@example.com",
      "https://x.com/abc", "https://twitter.com/abc", "https://t.me/abcde", "https://www.x.com", "https://example", "https://example.com.", "https://a..com",
    ]) {
      expect(ok(checkWebsite(bad))).toBeNull();
    }
  });

  test("a host written with look-alike letters (punycode) is refused: it can pass for another site", () => {
    for (const bad of ["https://аpple.com", "https://xn--pple-43d.com", "https://пример.рф", "https://example.xn--p1ai", "https://phantom․app.com"]) {
      expect(ok(checkWebsite(bad))).toBeNull();
    }
  });

  test("100 characters at most, the address as stored included", () => {
    expect(ok(checkWebsite(`example.com/${"a".repeat(80)}`))).not.toBeNull();
    expect(ok(checkWebsite(`example.com/${"a".repeat(100)}`))).toBeNull();
    expect(ok(checkWebsite(`${"a".repeat(92)}.example.com`))).toBeNull(); // 101 once https:// is added... and over the cap as typed
    expect(ok(checkWebsite("é".repeat(40) + ".com"))).toBeNull();
  });

  test("an empty or blank field is simply not given", () => {
    for (const check of [checkWebsite, checkX, checkTelegram]) expect(check("   ")).toEqual({ url: null, error: null });
  });
});

describe("the launch form and the server judge every input the same way", () => {
  const corpus = [
    "", "   ", "@snarkspad", "snarkspad", "x.com/snarkspad", "https://x.com/snarkspad/status/1", "https://twitter.com/a", "@a_B9", "a".repeat(15), "a".repeat(16), "@bad handle",
    "t.me/snarkspad", "https://telegram.me/snarkspad", "@abcd", "a".repeat(33), "example.com", "https://Example.com/coin?a=1", "http://example.com", "javascript:alert(1)",
    "https://x.com.evil.example/a", "https://notx.com/a", "https://x.com@evil.example/a", "https://t.me.evil.example/abcde", "https://xn--pple-43d.com", "https://аpple.com",
    "https://localhost", "https://127.0.0.1", "https://user:pass@example.com", "https://x.com/abc", "https://t.me/abcde", "https://example.com.", "https://a..com",
    `example.com/${"a".repeat(100)}`, `https://x.com/snarkspad?${"a=1&".repeat(40)}`, "х.com/snarkspad", "https://exa mple.com", "//example.com", "example", "https://example.com:8443/x",
  ];
  test.each([["website", checkWebsite, web.checkWebsite], ["x", checkX, web.checkX], ["telegram", checkTelegram, web.checkTelegram]] as const)("%s: same address, same refusal, for %d inputs", (_k, server, form) => {
    for (const input of corpus) {
      const a = server(input);
      const b = form(input);
      expect([input, a.url]).toEqual([input, b.url]);
      expect([input, a.error === null]).toEqual([input, b.error === null]);
    }
  });
});

describe("the links of a launch request", () => {
  test("absent, null and an empty object are no links", () => {
    for (const input of [undefined, null, {}]) expect(parseSocials(input)).toEqual({ ok: true, socials: {} });
  });

  test("each given link is checked and stored in its canonical form; an empty string is not given", () => {
    expect(parseSocials({ website: "example.com", x: "@snarkspad", telegram: "t.me/snarkspad" })).toEqual({
      ok: true, socials: { website: "https://example.com/", x: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad" },
    });
    expect(parseSocials({ website: "", x: null, telegram: "t.me/snarkspad" })).toEqual({ ok: true, socials: { telegram: "https://t.me/snarkspad" } });
  });

  test("a bad link names its field and nothing else; an unknown key, a list or a string is `socials`", () => {
    expect(parseSocials({ x: "https://x.com.evil.example/a" })).toEqual({ ok: false, field: "socials.x" });
    expect(parseSocials({ website: "http://example.com" })).toEqual({ ok: false, field: "socials.website" });
    expect(parseSocials({ telegram: 5 })).toEqual({ ok: false, field: "socials.telegram" });
    expect(parseSocials({ twitter: "https://x.com/a" })).toEqual({ ok: false, field: "socials" });
    expect(parseSocials(JSON.parse('{"__proto__": {"x": "https://x.com/a"}}'))).toEqual({ ok: false, field: "socials" });
    for (const input of [[], "x", 5, true]) expect(parseSocials(input)).toEqual({ ok: false, field: "socials" });
  });
});

describe("the links of a stored coin", () => {
  test("only known keys with an https address survive; a damaged cell is no links", () => {
    expect(readStoredSocials(JSON.stringify({ x: "https://x.com/a", website: "https://example.com/", telegram: "https://t.me/abcde" }))).toEqual({ x: "https://x.com/a", website: "https://example.com/", telegram: "https://t.me/abcde" });
    expect(readStoredSocials(JSON.stringify({ x: "javascript:alert(1)", website: "http://example.com", other: "https://example.com", telegram: 5 }))).toEqual({});
    for (const stored of [null, undefined, "", "not json", "[]", "5", "null"]) expect(readStoredSocials(stored)).toEqual({});
  });
});
