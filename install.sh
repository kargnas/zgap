#!/usr/bin/env bash
set -euo pipefail

bun_install_dir="${BUN_INSTALL:-${HOME:-${PWD}}/.bun}"
original_path="${PATH}"

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
# Remove a prior path or linked install first; otherwise Bun can keep two `zgap`
# entries in the global manifest and make the lockfile invalid.
global_package="${bun_install_dir}/install/global/package.json"
if [ -f "${global_package}" ] && [[ "$(<"${global_package}")" == *'"zgap"'* ]]; then
  bun remove -g zgap
fi
# Pin the registry: some machines set the default registry to npm.pkg.github.com
# for private GitHub Packages, which 404s public tarballs like path-to-regexp.
bun add -g github:kargnas/zgap#main --force --no-cache --registry https://registry.npmjs.org
# `bun add` keeps the lockfile's previously pinned commit even with --force --no-cache,
# so reruns of this installer need `bun update` to re-resolve #main to the latest commit.
bun update -g zgap --force --no-cache --registry https://registry.npmjs.org

zgap_bin_dir="${bun_install_dir}/bin"
printf '%s\n' "Installed zgap to ${zgap_bin_dir}/zgap."
case ":${original_path}:" in
  *":${zgap_bin_dir}:"*)
    printf '%s\n' 'Run `zgap` to get started.'
    ;;
  *)
    profile_bin_dir="${zgap_bin_dir}"
    if [ -n "${HOME:-}" ]; then
      profile_bin_dir="${zgap_bin_dir/#"${HOME}"/\$HOME}"
    fi
    case "${SHELL:-}" in
      */fish) profile_hint='~/.config/fish/config.fish'; path_line="fish_add_path \"${profile_bin_dir}\"" ;;
      */zsh) profile_hint='~/.zshrc'; path_line="export PATH=\"${profile_bin_dir}:\$PATH\"" ;;
      *) profile_hint='~/.bashrc'; path_line="export PATH=\"${profile_bin_dir}:\$PATH\"" ;;
    esac
    printf '%s\n' "${zgap_bin_dir} is not on your PATH yet, so \`zgap\` will not be found in this terminal."
    printf '%s\n' "Open a new terminal and run \`zgap\`. If it is still not found, add this line to ${profile_hint}:"
    printf '  %s\n' "${path_line}"
    ;;
esac
