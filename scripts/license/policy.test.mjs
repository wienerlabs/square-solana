// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, isPermissive, normalizeLicense, parseSpdx } from "./policy.mjs";

describe("parseSpdx", () => {
  it("tek kimlik", () => {
    assert.deepEqual(parseSpdx("MIT"), { id: "MIT" });
  });

  it("öncelik: WITH > AND > OR", () => {
    assert.deepEqual(parseSpdx("MIT OR Apache-2.0 AND BSD-3-Clause"), {
      op: "or",
      args: [{ id: "MIT" }, { op: "and", args: [{ id: "Apache-2.0" }, { id: "BSD-3-Clause" }] }],
    });
    assert.deepEqual(parseSpdx("Apache-2.0 WITH LLVM-exception OR MIT"), {
      op: "or",
      args: [{ id: "Apache-2.0", exception: "LLVM-exception" }, { id: "MIT" }],
    });
  });

  it("parantez önceliği değiştirir", () => {
    assert.deepEqual(parseSpdx("(MIT OR Apache-2.0) AND Unicode-3.0"), {
      op: "and",
      args: [{ op: "or", args: [{ id: "MIT" }, { id: "Apache-2.0" }] }, { id: "Unicode-3.0" }],
    });
  });

  it("küçük harfli operatörler ve kimlikler", () => {
    assert.deepEqual(parseSpdx("mit or apache-2.0"), {
      op: "or",
      args: [{ id: "MIT" }, { id: "Apache-2.0" }],
    });
  });

  for (const bad of ["", "   ", "MIT OR", "AND MIT", "(MIT", "MIT)", "MIT Apache-2.0", "SEE LICENSE IN LICENSE.md", "(MIT OR ISC) WITH LLVM-exception"]) {
    it(`geçersiz: ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseSpdx(bad));
    });
  }
});

describe("normalizeLicense", () => {
  it("Cargo'nun eski eğik çizgi yazımı OR olur", () => {
    assert.equal(normalizeLicense("MIT/Apache-2.0"), "MIT OR Apache-2.0");
    assert.equal(normalizeLicense("Unlicense/MIT"), "Unlicense OR MIT");
  });

  it("diğer ifadeler değişmez", () => {
    assert.equal(normalizeLicense(" (MIT OR Apache-2.0) "), "(MIT OR Apache-2.0)");
    assert.equal(normalizeLicense(undefined), "");
  });
});

describe("isPermissive", () => {
  const cases = [
    ["MIT", true],
    ["(MIT OR Apache-2.0)", true],
    ["MIT/Apache-2.0", true],
    ["GPL-3.0-only OR MIT", true],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", true],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["LGPL-2.1-only", false],
    ["LGPL-2.1+", false],
    ["MPL-2.0", false],
    ["Apache-2.0+", false],
    ["LicenseRef-Proprietary", false],
    ["SEE LICENSE IN LICENSE.md", false],
    ["UNKNOWN", false],
    ["NOT-INSTALLED", false],
    ["", false],
  ];
  for (const [license, expected] of cases) {
    it(`${JSON.stringify(license)} → ${expected}`, () => {
      assert.equal(isPermissive(license), expected);
    });
  }
});

describe("classify", () => {
  const assessed = {
    "npm:custom-licensed": { status: "review", note: "hukuki inceleme" },
    "cargo:cleared-crate": { status: "cleared", note: "izin verici eşdeğeri" },
  };

  it("izinli lisans → ok", () => {
    assert.deepEqual(classify("npm", "x", "ISC", assessed), { status: "ok" });
  });

  it("değerlendirilmiş: review → review, cleared → ok, notuyla", () => {
    assert.deepEqual(classify("npm", "custom-licensed", "SEE LICENSE IN LICENSE.md", assessed), {
      status: "review",
      note: "hukuki inceleme",
    });
    assert.deepEqual(classify("cargo", "cleared-crate", "LicenseRef-X", assessed), {
      status: "ok",
      note: "izin verici eşdeğeri",
    });
  });

  it("değerlendirme ekosisteme bağlıdır", () => {
    assert.deepEqual(classify("cargo", "custom-licensed", "UNKNOWN", assessed), { status: "fail" });
  });

  it("bilinmeyen ya da copyleft → fail", () => {
    assert.deepEqual(classify("npm", "y", "UNKNOWN", assessed), { status: "fail" });
    assert.deepEqual(classify("cargo", "z", "AGPL-3.0-only", assessed), { status: "fail" });
  });
});
