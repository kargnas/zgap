#!/usr/bin/env bash
set -euo pipefail

bun_install_dir="${BUN_INSTALL:-${HOME:-${PWD}}/.bun}"
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "${bun_install_dir}/bin/bun" ]; then
    PATH="${bun_install_dir}/bin:${PATH}"
    export PATH
  else
    curl -fsSL https://bun.com/install | bash
    PATH="${bun_install_dir}/bin:${PATH}"
    export PATH
  fi
fi

command -v bun >/dev/null 2>&1
bun add -g zgap@latest
