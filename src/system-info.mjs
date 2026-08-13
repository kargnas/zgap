import os from "node:os";

const OS_NAMES = {
  aix: "AIX",
  android: "Android",
  darwin: "macOS",
  freebsd: "FreeBSD",
  linux: "Linux",
  openbsd: "OpenBSD",
  sunos: "SunOS",
  win32: "Windows",
};

function bounded(value, maximum) {
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, maximum) || "unknown";
}

export async function readSystemInfo() {
  const platform = os.platform();
  return {
    hostname: bounded(os.hostname(), 255),
    os_name: bounded(OS_NAMES[platform] ?? platform, 32),
    os_version: bounded(os.release(), 128),
    os_arch: bounded(os.arch(), 32),
  };
}
