import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";

test("readSystemInfo는 현재 플랫폼을 제한된 JSON 메타데이터로 정규화한다", async () => {
  const { readSystemInfo } = await import("../src/system-info.mjs");
  const systemInfo = await readSystemInfo();
  const expectedNames = {
    darwin: "macOS",
    freebsd: "FreeBSD",
    linux: "Linux",
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
