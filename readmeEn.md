# OpenCinema Studio

**A local video creation workbench operated by your agent.**

[中文](readme.md) · [Claude setup](docs/claudeSetup.md) · [Contributing](contributing.md) · [Releases](docs/releaseGuide.md) · [MIT](LICENSE)

OpenCinema combines a React node canvas, Go server and extensible media tools. Codex, Claude Code or another MCP host provides planning and conversation. The workbench owns projects, assets, editing, undo/redo and persistence. There is no separate required desktop application or embedded general chat model.

Version **0.4.0 is unreleased**. The instructions below use a local source checkout or a complete package built for your OS and CPU.

## Capabilities

- Text, image, video, audio and generation nodes; selection, groups, connections, alignment and history.
- Local media editors, clipping, speed changes, keyframes and metadata.
- Blockout scenes, takes, camera moves, full animatics, per-shot RGB/depth snapshots and video depth analysis.
- Explicit generation plans and reference roles; candidate review, 2–16-shot edit plans, individual shot replacement and a mixed/replaced audio track.
- Fourteen built-in node/extension packages with discoverable schemas, target/revision guards and operation recovery.

Completion of a technical task is distinct from an approved shot or a high-quality finished film.

## Source quick start

Prerequisites: Bun 1.3.14+, Go 1.26+, and Node.js 22+ for the plugin runtime.

```sh
bun install --frozen-lockfile
bun run build
bun start
```

Open http://127.0.0.1:47920 and select your project directory. Builds do not install models, download weights or submit generation requests. For development, explicitly build node packages with `bun run build:nodes`, then run `bun run dev:server` and `bun run dev:web` in separate terminals.

## Claude Code

Use the built plugin directory, not its TypeScript source:

```sh
claude plugin validate ./build/openCinema --strict
claude --plugin-dir ./build/openCinema
```

Or install from the local marketplace:

```sh
claude plugin marketplace add ./ --scope local
claude plugin install opencinema@openCinemaStandalone --scope local
```

The optional Claude plugin configuration `runtimeInfo` selects an existing local runtime explicitly; leave it empty for managed startup. The reported backend revision remains the actual version.

Invoke `/opencinema:opencinema`. Discover `getAppState` first, select an explicit project and connection, then discover the actual node tools. Claude Code requires a connected React Web provider for canvas operations. A desktop login does not imply that a separately installed CLI is authenticated. See [Claude setup](docs/claudeSetup.md) for installation, external-runtime connections and troubleshooting.

## Codex

From a fully built checkout:

```sh
codex plugin marketplace add . --json
codex plugin add opencinema@openCinemaStandalone --json
```

Enable OpenCinema Studio, discover its actual tools, call `getAppState`, then use `renderOpenCinema` on a host supporting MCP Apps. The source marketplace points to the ignored build/openCinema directory: cloning this repository as a Git marketplace is not a no-build install. Distribute a complete native package for end users.

## Media and models

FFmpeg/FFprobe are optional local processing tools configured in the workbench. Video Depth Anything Small uses an explicitly prepared Python 3.10–3.12 environment and model weights. Weights are not included.

General agent capabilities and specialized video providers are separate. A Codex or Claude subscription does not promise access to every video model or free generation. Configure your own authorized provider locally. Never commit credentials or runtime metadata. Ordinary video references are soft references unless the provider explicitly declares dedicated depth control.

A complete workflow is discovery → scoped edits or authorized tasks → actual playback and review → saved edit plan → export → save and readback. See [shot workflow](docs/videoShotWorkflow.md). Preserve rejected candidates and replace only the affected shot.

## Development and distribution

```sh
bun run typecheck
bun run build
bun run release
```

The release command archives existing build/openCinema output and writes SHA-256 checksums and a release manifest; it does not install dependencies, rebuild or publish. It currently requires system zip on macOS/Linux. Native platform compatibility and actual host execution must be verified separately.

See [contribution guidance](contributing.md), [issue template](docs/issueTemplate.md), [PR template](docs/pullRequestTemplate.md), [security policy](security.md) and [code of conduct](codeOfConduct.md).

## License and acknowledgments

[MIT](LICENSE), preserving HBAI-Ltd copyright. Third-party components, fonts, icons, model weights and FFmpeg builds retain their own licenses. Packages include [third-party notices](thirdPartyNotices.md), an installed-dependency license catalog and available license texts; this catalog is a dependency superset rather than exact bundle attribution.

The distribution/documentation approach references [Cowart](https://github.com/zhongerxin/Cowart). OpenCinema retains its own Go/React architecture and explicit host/runtime boundaries.
