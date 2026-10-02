#!/usr/bin/env bash
set -euo pipefail

ROOT=$(realpath -m -- "${DOCUMENT_TOOLS_ROOT:-$PWD/.document-tools}")
DOWNLOAD_ROOT=$(realpath -m -- "${DOCUMENT_TOOLS_DOWNLOAD_ROOT:-$ROOT/install-cache}")
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DOWNLOADS="$DOWNLOAD_ROOT/downloads"
mkdir -p "$DOWNLOADS" "$ROOT/bin" "$ROOT/pandoc"

# Pinned official TeX Live network installer. Keep its package verification enabled.
TL_ARCHIVE=install-tl-unx.tar.gz
TL_SHA256=0441250d4369e05b855515c54427f6c1f095cd2f149db201a71110b33b332928
if [[ ! -f "$DOWNLOADS/$TL_ARCHIVE" ]]; then
  curl -fL --retry 3 https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz -o "$DOWNLOADS/$TL_ARCHIVE"
fi
printf '%s  %s\n' "$TL_SHA256" "$DOWNLOADS/$TL_ARCHIVE" | sha256sum --check --status
if [[ ! -x "$ROOT/texlive/2026/bin/x86_64-linux/latexmk" ]]; then
  tar -xzf "$DOWNLOADS/$TL_ARCHIVE" -C "$DOWNLOADS"
  INSTALLER=$(find "$DOWNLOADS" -maxdepth 2 -type f -path '*/install-tl' -print -quit)
  [[ -n "$INSTALLER" ]]
  node --input-type=commonjs -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1], "utf8").replaceAll("@DOCUMENT_TOOLS_ROOT@", process.argv[3]));' "$SCRIPT_DIR/document-tools-texlive.profile" "$DOWNLOADS/texlive.profile" "$ROOT"
  perl "$INSTALLER" -no-gui -profile "$DOWNLOADS/texlive.profile" -repository https://mirror.ctan.org/systems/texlive/tlnet
fi

TLBIN="$ROOT/texlive/2026/bin/x86_64-linux"
"$TLBIN/tlmgr" install latexmk ctex cjk xecjk fontspec fandol bibtex biblatex biber luaotfload

# Pandoc publishes a static Linux tarball; verify its official release digest before unpacking.
PANDOC_ARCHIVE=pandoc-3.12-linux-amd64.tar.gz
PANDOC_SHA256=67d7d011fed8c8543306022b985b9b2499ab9b74818df91d8727c7e9ebc5ba06
if [[ ! -f "$DOWNLOADS/$PANDOC_ARCHIVE" ]]; then
  curl -fL --retry 3 "https://github.com/jgm/pandoc/releases/download/3.12/$PANDOC_ARCHIVE" -o "$DOWNLOADS/$PANDOC_ARCHIVE"
fi
printf '%s  %s\n' "$PANDOC_SHA256" "$DOWNLOADS/$PANDOC_ARCHIVE" | sha256sum --check --status
if [[ ! -x "$ROOT/pandoc/bin/pandoc" ]]; then
  tar -xzf "$DOWNLOADS/$PANDOC_ARCHIVE" --strip-components=1 -C "$ROOT/pandoc"
fi
ln -sf "$ROOT/pandoc/bin/pandoc" "$ROOT/bin/pandoc"
for tool in latexmk pdflatex xelatex lualatex synctex kpsewhich biber bibtex; do
  ln -sf "$TLBIN/$tool" "$ROOT/bin/$tool"
done
"$ROOT/bin/pandoc" --version | head -1
"$ROOT/bin/latexmk" -v | head -2

# LibreOffice is provisioned separately as the pinned Ubuntu 22.04 package set. Its Writer
# package does not include the Math UNO component required to import DOCX OMML equations.
# Add the exactly matching Math package only when that isolated LO 7.3 runtime is present.
LO73_ROOT="$ROOT/libreoffice-7.3"
if [[ -x "$LO73_ROOT/usr/bin/libreoffice" ]]; then
  LO_MATH_ARCHIVE=libreoffice-math_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb
  LO_MATH_SHA256=1645934bcef5f981698ca04cf38782ad8a792ba25fd8e4acb09c1b60474f7db4
  LO_MATH_URL=https://archive.ubuntu.com/ubuntu/pool/main/l/libreoffice/libreoffice-math_7.3.7-0ubuntu0.22.04.12_amd64.deb
  if [[ ! -f "$DOWNLOADS/$LO_MATH_ARCHIVE" ]]; then
    curl -fL --retry 3 "$LO_MATH_URL" -o "$DOWNLOADS/$LO_MATH_ARCHIVE"
  fi
  printf '%s  %s\n' "$LO_MATH_SHA256" "$DOWNLOADS/$LO_MATH_ARCHIVE" | sha256sum --check --status
  dpkg-deb -x "$DOWNLOADS/$LO_MATH_ARCHIVE" "$LO73_ROOT"
fi
