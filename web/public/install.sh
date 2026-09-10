#!/usr/bin/env bash
# swap — one-shot installer
#
#   curl -fsSL https://swap.9summits.io/install.sh | bash
#
# Downloads a prebuilt binary for this OS/arch from https://swap.9summits.io/cli
# (or SWAP_INSTALL_BASE). Installs to ~/.local/bin/swap (or SWAP_INSTALL_DIR).
set -euo pipefail

# /cli/* 302s to the public Blob store. Override with SWAP_INSTALL_BASE.
# install.sh itself is hosted at https://swap.9summits.io/install.sh
BASE="${SWAP_INSTALL_BASE:-https://swap.9summits.io/cli}"
INSTALL_DIR="${SWAP_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="swap"

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "required command not found: $1"
}

# Brand gradient from the dApp primary button (Connect Wallet):
#   --gradient-brand: linear-gradient(90deg, #ff9655 0%, #fe4d7a 45%, #ff008c 100%)
# Empty track is ink-700 (#272233). Percent text is text-primary (#ece9f3).
# SWAP_NO_PROGRESS=1 or a non-TTY stderr keeps the old silent download.

detect_asset() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin|linux) ;;
    msys*|mingw*|cygwin*)
      err "Windows is not supported by this installer yet. Build from source."
      ;;
    *)
      err "unsupported OS: $(uname -s). Supported: macOS (darwin), Linux."
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      err "unsupported architecture: $arch. Supported: x64, arm64."
      ;;
  esac

  printf '%s\n' "${BIN_NAME}-${os}-${arch}"
}

# Global so the EXIT trap can always see them (locals vanish when main returns).
SWAP_TMPDIR=""
SWAP_CURL_PID=""
SWAP_CURSOR_HIDDEN=""
SWAP_PROGRESS=""
SWAP_BAR_WIDTH=""
SWAP_BAR_COLOR=""

restore_cursor() {
  if [ -n "${SWAP_CURSOR_HIDDEN}" ]; then
    printf '\033[?25h' >&2
    SWAP_CURSOR_HIDDEN=""
  fi
}

cleanup() {
  if [ -n "${SWAP_CURL_PID}" ]; then
    kill "${SWAP_CURL_PID}" 2>/dev/null || true
    wait "${SWAP_CURL_PID}" 2>/dev/null || true
    SWAP_CURL_PID=""
  fi
  restore_cursor
  if [ -n "${SWAP_TMPDIR}" ] && [ -d "${SWAP_TMPDIR}" ]; then
    rm -rf "${SWAP_TMPDIR}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

progress_wanted() {
  [ -t 2 ] || return 1
  [ -z "${SWAP_NO_PROGRESS:-}" ] || return 1
  case "${TERM:-}" in
    dumb) return 1 ;;
  esac
  return 0
}

color_wanted() {
  progress_wanted || return 1
  [ -z "${NO_COLOR:-}" ] || return 1
  return 0
}

filesize() {
  if [ ! -f "$1" ]; then
    printf '0'
    return
  fi
  case "$(uname -s)" in
    Darwin) command stat -f%z "$1" ;;
    *)      command stat -c%s "$1" ;;
  esac
}

# Last Content-Length in a curl -D / wget -S dump (redirect hops included).
content_length() {
  local f="$1"
  [ -s "$f" ] || { printf '0'; return; }
  tr -d '\r' < "$f" | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }'
}

fmt_mb() {
  local n="$1" x10
  x10=$((n * 10 / 1048576))
  printf '%d.%d MB' $((x10 / 10)) $((x10 % 10))
}

fmt_bytes() {
  local n="$1"
  if [ "$n" -ge 1048576 ]; then
    fmt_mb "$n"
  elif [ "$n" -ge 1024 ]; then
    printf '%d KB' $((n / 1024))
  else
    printf '%d B' "$n"
  fi
}

bar_width() {
  local cols w
  cols="${COLUMNS:-}"
  if [ -z "$cols" ]; then
    cols="$(command tput cols 2>/dev/null || echo 80)"
  fi
  # brackets + "  100%  " + 20-char size, plus a couple of columns of slack
  # so the line never wraps (wrap + \r is what makes the bar jump).
  w=$((cols - 34))
  if [ "$w" -gt 40 ]; then w=40; fi
  if [ "$w" -lt 12 ]; then w=12; fi
  printf '%s' "$w"
}

# One atomic \r-write. Same glyph for fill and empty so column width is
# constant; never clear-then-repaint (that flashes an empty line each tick).
draw_progress() {
  local current="$1" total="$2"
  local width filled i p t r g b pct sizestr buf cell right
  width="${SWAP_BAR_WIDTH:-40}"

  if [ "$total" -gt 0 ]; then
    filled=$((current * width / total))
    [ "$filled" -gt "$width" ] && filled=$width
    pct=$((current * 100 / total))
    [ "$pct" -gt 100 ] && pct=100
    if [ "$total" -ge 1048576 ] && [ "$current" -ge 1048576 ]; then
      sizestr="$(fmt_mb "$current") / $(fmt_mb "$total")"
    elif [ "$total" -ge 1048576 ]; then
      sizestr="$(fmt_bytes "$current") / $(fmt_mb "$total")"
    else
      sizestr="$(fmt_bytes "$current") / $(fmt_bytes "$total")"
    fi
  else
    filled=0
    pct=-1
    if [ "$current" -gt 0 ]; then
      sizestr="$(fmt_bytes "$current")"
    else
      sizestr=""
    fi
  fi

  buf=""
  if [ "${SWAP_BAR_COLOR:-0}" -eq 1 ]; then
    printf -v buf '\033[38;2;108;100;128m['
    i=0
    while [ "$i" -lt "$width" ]; do
      if [ "$i" -lt "$filled" ]; then
        if [ "$width" -le 1 ]; then p=0; else p=$((i * 1000 / (width - 1))); fi
        if [ "$p" -le 450 ]; then
          t=$((p * 1000 / 450))
          r=$((255 + (254 - 255) * t / 1000))
          g=$((150 + (77 - 150) * t / 1000))
          b=$((85 + (122 - 85) * t / 1000))
        else
          t=$(((p - 450) * 1000 / 550))
          r=$((254 + (255 - 254) * t / 1000))
          g=$((77 + (0 - 77) * t / 1000))
          b=$((122 + (140 - 122) * t / 1000))
        fi
        printf -v cell '\033[38;2;%d;%d;%dm█' "$r" "$g" "$b"
      else
        printf -v cell '\033[38;2;39;34;51m█'
      fi
      buf="${buf}${cell}"
      i=$((i + 1))
    done
    if [ "$pct" -ge 0 ]; then
      printf -v right '\033[0m\033[38;2;108;100;128m]\033[0m  \033[38;2;236;233;243m%3d%%\033[0m  \033[38;2;165;159;184m%-20s\033[0m' \
        "$pct" "$sizestr"
    else
      printf -v right '\033[0m\033[38;2;108;100;128m]\033[0m        \033[38;2;165;159;184m%-20s\033[0m' \
        "$sizestr"
    fi
    buf="${buf}${right}"
  else
    buf='['
    i=0
    while [ "$i" -lt "$width" ]; do
      if [ "$i" -lt "$filled" ]; then
        buf="${buf}#"
      else
        buf="${buf}-"
      fi
      i=$((i + 1))
    done
    if [ "$pct" -ge 0 ]; then
      printf -v right ']  %3d%%  %-20s' "$pct" "$sizestr"
    else
      printf -v right ']        %-20s' "$sizestr"
    fi
    buf="${buf}${right}"
  fi

  printf '\r%s\033[K' "$buf" >&2
}

erase_progress() {
  [ -n "${SWAP_PROGRESS}" ] || return 0
  # Bar line, then the "downloading …" line above it.
  printf '\r\033[K\033[1A\033[K' >&2
  SWAP_PROGRESS=""
  restore_cursor
}

watch_progress() {
  local dest="$1" hdr="$2"
  local current total=0
  while kill -0 "${SWAP_CURL_PID}" 2>/dev/null; do
    current=$(($(filesize "$dest")))
    if [ "$total" -eq 0 ]; then
      total=$(($(content_length "$hdr")))
    fi
    draw_progress "$current" "$total"
    sleep 0.1
  done
}

# --proto/--proto-redir pin every hop to https, the curl-side equivalent of the
# per-hop check in src/update.ts. wget has no per-hop equivalent.
download_with_progress() {
  local url="$1" dest="$2" label="$3" hdr rc=0 current total
  hdr="${dest}.hdr"
  : >"$hdr"

  SWAP_BAR_WIDTH="$(bar_width)"
  SWAP_BAR_COLOR=0
  if color_wanted; then SWAP_BAR_COLOR=1; fi

  SWAP_PROGRESS=1
  printf '\033[?25l' >&2
  SWAP_CURSOR_HIDDEN=1
  if [ "$SWAP_BAR_COLOR" -eq 1 ]; then
    printf '\033[38;2;165;159;184mdownloading\033[0m \033[1m%s\033[0m\n' "$label" >&2
  else
    printf 'downloading %s\n' "$label" >&2
  fi
  draw_progress 0 0

  if command -v curl >/dev/null 2>&1; then
    # stderr discarded: curl's own errors would scramble the bar; main() reports failure.
    command curl -fL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 -s -D "$hdr" -o "$dest" "$url" 2>/dev/null &
    SWAP_CURL_PID=$!
  else
    command wget -q -S -O "$dest" "$url" >"$hdr" 2>&1 &
    SWAP_CURL_PID=$!
  fi

  watch_progress "$dest" "$hdr"
  wait "${SWAP_CURL_PID}" || rc=$?
  SWAP_CURL_PID=""

  if [ "$rc" -ne 0 ]; then
    erase_progress
    return 1
  fi

  current=$(($(filesize "$dest")))
  total=$(($(content_length "$hdr")))
  if [ "$total" -lt "$current" ]; then total=$current; fi
  draw_progress "$current" "$total"
  printf '\n' >&2
  SWAP_PROGRESS=""
  restore_cursor
  return 0
}

download() {
  local url="$1" dest="$2" label="$3"
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    :
  else
    err "need curl or wget to download the binary"
  fi

  if progress_wanted; then
    download_with_progress "$url" "$dest" "$label" || return 1
    return 0
  fi

  if command -v curl >/dev/null 2>&1; then
    command curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 -o "$dest" "$url" || return 1
    return 0
  fi
  command wget -q -O "$dest" "$url" || return 1
}

download_quiet() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    command curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 120 -o "$dest" "$url" || return 1
    return 0
  fi
  command wget -q -O "$dest" "$url" || return 1
}

file_sha256() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$f" | awk '{print $NF}'
  else
    err "need sha256sum, shasum, or openssl to verify the download"
  fi
}

main() {
  need_cmd uname
  need_cmd mktemp
  need_cmd mkdir
  need_cmd chmod
  need_cmd mv

  local asset url tmpbin tmpsha size expected actual scheme
  BASE="${BASE%/}"
  scheme="$(printf '%s' "${BASE%%://*}" | tr '[:upper:]' '[:lower:]')"
  if [ "$scheme" != "https" ]; then
    err "SWAP_INSTALL_BASE must be an https URL (got ${BASE})"
  fi

  asset="$(detect_asset)"
  url="${BASE}/${asset}"

  SWAP_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/swap-install.XXXXXX")"
  tmpbin="${SWAP_TMPDIR}/${asset}"

  if ! download "$url" "$tmpbin" "$asset"; then
    err "failed to download ${asset} from ${url}
  No prebuilt binary for this platform, or the asset is missing from the current release store.
  Supported prebuilts: swap-darwin-arm64, swap-darwin-x64, swap-linux-arm64, swap-linux-x64
  Build from source (requires Bun):
    git clone https://github.com/9summits/9Swap.git && cd 9Swap && bun install && SWAP_PUBLIC_BUILD=1 ./build
    install dist/swap ${INSTALL_DIR}/swap"
  fi

  if [ ! -s "$tmpbin" ]; then
    err "downloaded file is empty — check ${url}"
  fi
  # Bun-compiled binaries are tens of MB; a few KB almost always means 404 HTML.
  size="$(wc -c <"$tmpbin" | tr -d ' ')"
  if [ "$size" -lt 1000000 ]; then
    err "downloaded file is only ${size} bytes (expected a multi-MB binary). URL may be wrong or the asset missing: ${url}"
  fi

  tmpsha="${SWAP_TMPDIR}/${asset}.sha256"
  if ! download_quiet "${url}.sha256" "$tmpsha"; then
    err "failed to download checksum from ${url}.sha256"
  fi
  expected="$(tr -d '\r' <"$tmpsha" | awk '{print $1; exit}' | tr '[:upper:]' '[:lower:]')"
  if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
    err "checksum at ${url}.sha256 is not a 64-char SHA-256 hex digest"
  fi
  actual="$(file_sha256 "$tmpbin" | tr '[:upper:]' '[:lower:]')"
  if [ "$actual" != "$expected" ]; then
    err "checksum mismatch for ${url}: expected ${expected}, got ${actual}"
  fi

  mkdir -p "$INSTALL_DIR"
  chmod +x "$tmpbin"
  mv -f "$tmpbin" "${INSTALL_DIR}/${BIN_NAME}"

  info ""
  info "installed ${INSTALL_DIR}/${BIN_NAME}"

  case ":$PATH:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      info ""
      info "note: ${INSTALL_DIR} is not on your PATH."
      info "  add this to your shell profile (~/.zshrc / ~/.bashrc):"
      info "    export PATH=\"${INSTALL_DIR}:\$PATH\""
      info "  then open a new terminal (or: source ~/.zshrc)"
      ;;
  esac

  info ""
  info "try:"
  info "  swap --help"
  info "  swap 100 USDC WETH"
  info "  swap #launch dapp locally"
}

main "$@"
