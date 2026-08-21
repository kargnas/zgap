#!/usr/bin/env bash
set -euo pipefail

bun_install_dir="${BUN_INSTALL:-${HOME:-${PWD}}/.bun}"

if ! command -v bun >/dev/null 2>&1; then
  if [ -x "${bun_install_dir}/bin/bun" ]; then
    PATH="${bun_install_dir}/bin:${PATH}"
    export PATH
  else
    if ! command -v unzip >/dev/null 2>&1; then
      if ! command -v apt-get >/dev/null 2>&1; then
        printf '%s\n' "Installing unzip requires apt-get." >&2
        exit 1
      fi
      apt_command=(apt-get)
      if [ "$(id -u)" -ne 0 ]; then
        if ! command -v sudo >/dev/null 2>&1; then
          printf '%s\n' "Installing unzip requires root or sudo." >&2
          exit 1
        fi
        apt_command=(sudo apt-get)
      fi
      "${apt_command[@]}" update
      "${apt_command[@]}" install -y unzip
    fi
    curl -fsSL https://bun.com/install | bash
    PATH="${bun_install_dir}/bin:${PATH}"
    export PATH
  fi
fi

command -v bun >/dev/null 2>&1
# Pin the registry: some machines set the default registry to npm.pkg.github.com
# for private GitHub Packages, which 404s public tarballs like path-to-regexp.
bun add -g github:kargnas/zgap#main --force --no-cache --registry https://registry.npmjs.org
# `bun add` keeps the lockfile's previously pinned commit even with --force --no-cache,
# so reruns of this installer need `bun update` to re-resolve #main to the latest commit.
bun update -g zgap --force --no-cache --registry https://registry.npmjs.org
