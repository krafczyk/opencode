<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### MkChad Linux Release Packages

The MkChad fork publishes direct npm tarballs only through the
[MkChad GitHub Releases](https://github.com/krafczyk/opencode/releases) page.
Each `v<version>` release contains exactly these assets:

- `opencode-ai-<version>-linux-x64.tgz`
- `opencode-ai-<version>-linux-arm64.tgz`
- `SHA256SUMS`

These packages support glibc Linux x64 and ARM64 only. The `linux-x64` package
uses AVX2 and is not a baseline x64 build. Both packages include the embedded
web client and MkChad fork behavior, expose `opencode` through npm global
installation, and refuse installation on another operating system or CPU.

Install a reviewed release only after verifying its checksum. Select the asset
for the host architecture:

```bash
VERSION=1.18.3-mkchad.6
BASE="https://github.com/krafczyk/opencode/releases/download/v$VERSION"
curl --fail --location --remote-name "$BASE/SHA256SUMS"
curl --fail --location --remote-name "$BASE/opencode-ai-$VERSION-linux-x64.tgz"
sha256sum --check --ignore-missing SHA256SUMS
npm install --global "./opencode-ai-$VERSION-linux-x64.tgz"
opencode --version
```

Use the `linux-arm64` filename instead on ARM64. MkChad packages never check
for or install an upstream replacement. `opencode upgrade` instead directs
users to a reviewed GitHub Release or their managed MkChad container update.

#### Release Administration

`MkChad release packages` accepts tags from the protected `mkchad` and
`mkchad-v1` branches.
A tag matching `rehearsal-v<major>.<minor>.<patch>-mkchad.<revision>` runs the
same validation, native x64/ARM64 build, direct npm installation, version, and
managed-upgrade refusal checks as a release, but it never creates a release.
Only a tag matching `v<major>.<minor>.<patch>-mkchad.<revision>` can enter
publication. Every tag must resolve to the checked-out commit and be reachable
from `mkchad` or `mkchad-v1`; the source branch does not determine whether the
run publishes. Delete a completed rehearsal tag only after retaining its run as
release evidence; never reuse its name for different content.

Before the first tag, repository administrators must enable immutable GitHub
Releases, protect `mkchad` and `mkchad-v1`, and configure a tag ruleset that
restricts MkChad release tags to authorized maintainers. They must also create the protected
`mkchad-release` environment with the required reviewers. Add an environment
secret named `MKCHAD_RELEASE_ADMIN_TOKEN` containing a fine-grained token limited
to this repository with only Administration read permission. GitHub requires
that permission to read immutable-release settings; the workflow uses the token
only for that preflight and uses its scoped `GITHUB_TOKEN` to publish. The
workflow cannot create or modify repository protections. Once GitHub publishes
the draft, immutable-release protection locks the release assets and associated
tag, and the workflow verifies the published release's immutable status. If
GitHub displays an automatic release attestation, it is GitHub platform
metadata; this workflow does not request or create workflow artifact
attestations. It uses no npm registry credentials.

Runs sharing a ref are deliberately not cancelled. If a run stops after draft
creation, do not rerun the tag: the existing release or draft blocks the retry.
An authorized maintainer must inspect the draft tag, target commit, exact three
asset names, and downloaded checksums. After that explicit reconciliation, they
may publish the verified draft manually or deliberately delete it before a clean
rerun. The workflow never deletes or adopts an interrupted draft.

Native GitHub-hosted `ubuntu-24.04` and `ubuntu-24.04-arm` smoke tests are the
current prepublication gate. A pinned Fedora 43 container smoke is deferred to
U4/U5, where its image digest and container runtime contract can be reviewed
with the container adoption work instead of adding unpinned provisioning here.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
