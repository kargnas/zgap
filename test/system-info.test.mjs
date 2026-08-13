import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";

test("readSystemInfo는 지원하는 모든 플랫폼 이름을 정규화한다", async () => {
  const { normalizeSystemInfo } = await import("../src/system-info.mjs");
  const expectedNames = new Map([
    ["aix", "AIX"],
    ["android", "Android"],
    ["darwin", "macOS"],
    ["freebsd", "FreeBSD"],
    ["linux", "Linux"],
    ["openbsd", "OpenBSD"],
    ["sunos", "SunOS"],
    ["win32", "Windows"],
  ]);

  for (const [platform, expectedName] of expectedNames) {
    assert.equal(normalizeSystemInfo({ platform, hostname: "host", release: "release", arch: "x64" }).os_name, expectedName);
  }
});

test("readSystemInfo는 필드별 길이와 안전하지 않은 문자를 정규화한다", async () => {
  const { normalizeSystemInfo } = await import("../src/system-info.mjs");
  assert.deepEqual(normalizeSystemInfo({
    platform: "unknown-platform",
    hostname: `host\u0000${"h".repeat(300)}`,
    release: `\u0001${"r".repeat(200)}`,
    arch: "",
  }), {
    hostname: `host${"h".repeat(251)}`,
    os_arch: "unknown",
    os_name: "unknown-platform",
    os_version: "r".repeat(128),
  });
});

test("readSystemInfo는 현재 플랫폼의 메타데이터 모양을 유지한다", async () => {
  const { readSystemInfo } = await import("../src/system-info.mjs");
  const systemInfo = await readSystemInfo();
  const expectedNames = {
    aix: "AIX",
    android: "Android",
    darwin: "macOS",
    freebsd: "FreeBSD",
    linux: "Linux",
    openbsd: "OpenBSD",
    sunos: "SunOS",
    win32: "Windows",
  };

  assert.deepEqual(Object.keys(systemInfo).sort(), ["hostname", "os_arch", "os_name", "os_version"]);
  assert.equal(systemInfo.os_name, expectedNames[os.platform()] ?? os.platform());
  assert.equal(systemInfo.os_version, os.release().slice(0, 128));
  assert.equal(systemInfo.os_arch, os.arch());
  assert.equal(systemInfo.hostname, os.hostname().slice(0, 255));
  for (const value of Object.values(systemInfo)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
    assert.ok(value.length <= 255);
    assert.equal(/[\u0000-\u001f\u007f]/u.test(value), false);
  }
});
