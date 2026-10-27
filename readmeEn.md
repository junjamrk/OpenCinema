<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logoDark.png">
    <img src="assets/brand/logoLight.png" alt="OpenCinema" width="460">
  </picture>
</p>

<h3 align="center">Your agent. Your canvas. Your film.</h3>

<p align="center">
  Direct in Codex or Claude. Create, refine, and finish in OpenCinema.<br>
  A shared canvas for shots, media, previs, and the final edit.
</p>

<p align="center">
  <a href="readme.md">中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/claudeSetup.md">Claude setup</a> ·
  <a href="contributing.md">Contributing</a> ·
  <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <a href="assets/promo/openCinemaPromo.mp4">
    <img src="assets/promo/promoPreview.gif" alt="OpenCinema: AI tools, canvas workflows, providers and plugins" width="960">
  </a>
</p>

<p align="center">
  <a href="assets/promo/openCinemaPromo.mp4">Watch the full film · 58 seconds · 1080p</a> ·
  <a href="assets/promo/promoPoster.jpg">Full-resolution poster</a>
</p>

<p align="center"><sub>Product motion concept. Generated footage depends on the chosen model, references, and shot review.</sub></p>

## One canvas. The whole creative process.

- **Selection sets the scope.** Refine one node or direct a whole sequence.
- **Create with your agent.** Direct from Codex, Claude, or another MCP host.
- **Edit where your ideas live.** Image, audio, and video tools share the canvas.
- **Previsualize before you generate.** Stage action and cameras, then freeze per-shot RGB and depth references.
- **Keep the good takes. Refine the rest.** Review, trim, replace a shot, and render the full edit.
- **Your models. Your tools.** Extend the workbench through MCP and plugins, using explicitly configured generation services.

## Start with a conversation

1. **Choose the scope.** Select a node or a group of shots and describe the change in the bottom composer.
2. **See and refine.** Your agent works on the same canvas. Open a local editor, adjust a reference, or keep a take you like.
3. **Review and finish.** Check the actual footage, revise the affected shots, save the edit plan, and export.

Learn more: [shot workflow](docs/videoShotWorkflow.md) · [video providers](docs/videoProvider.md).

## Quick start

**0.4.0 · In development.** Source builds need **Bun 1.3.14+ and Go 1.26+**. Plugin execution needs **Node.js 22+**.

~~~sh
git clone https://github.com/junjamrk/OpenCinema.git
cd OpenCinema
bun install --frozen-lockfile
bun run build
bun start
~~~

Open [the local workbench](http://127.0.0.1:47920) and select a project folder. See [contributing](contributing.md) for development and [releases](docs/releaseGuide.md) for complete native packages.

### Claude Code

From a fully built checkout, load the plugin for one session:

~~~sh
claude --plugin-dir ./build/openCinema
~~~

Or install it locally for this project:

~~~sh
claude plugin marketplace add ./ --scope local
claude plugin install opencinema@openCinemaStandalone --scope local
~~~

Invoke <code>/opencinema:opencinema</code>, read <code>getAppState</code>, then open an existing project. See [Claude setup](docs/claudeSetup.md) for connection options.

### Codex

From a fully built checkout:

~~~sh
codex plugin marketplace add . --json
codex plugin add opencinema@openCinemaStandalone --json
~~~

Enable **OpenCinema Studio** and discover the live connection with <code>getAppState</code>. Hosts supporting MCP Apps can open the workbench with <code>renderOpenCinema</code>.

<details>
<summary>Runtime and model notes</summary>

- Your host agent provides planning and conversation. React owns editing; Go owns authorization, files, and tasks. The ordinary Web composer needs an online Host to receive and process instructions.
- Build before installing the source marketplace, or use a complete package matching your OS and CPU. Tool access and visual Widget support depend on the specific host.
- Specialized generation services are configured separately and may charge fees. A host subscription does not include every video model. Keep credentials local and out of projects and Git.
- Local processing uses configured FFmpeg/FFprobe. Video Depth Anything Small needs Python 3.10–3.12 and an explicitly prepared environment and weights; builds do not download models.
- Previs and relative depth are references. Ordinary video references do not guarantee exact motion control. The current edit plan supports 2–16 shots and one external mixed/replaced audio track.

</details>

## Extend your creative toolkit

A Go service, React canvas, framework-independent editing session, and node SDK make up the workbench. Fourteen built-in node/extension packages share manual and agent operations, discoverable schemas, revision guards, history, save, and readback.

[Contributing](contributing.md) · [Node SDK](packages/nodeScaffold/readme.md) · [MCP SDK](packages/mcp/README.md) · [Plugin guide](packages/openCinema/readme.md) · [Changelog](changelog.md)

[Issues](https://github.com/junjamrk/OpenCinema/issues) · [Security](security.md) · [Code of conduct](codeOfConduct.md)

## License and acknowledgments

[MIT](LICENSE), preserving HBAI-Ltd copyright. Blockout, Motion, fonts, and icons keep their own licenses; model weights, FFmpeg builds, and user media retain their respective terms. See [third-party notices](thirdPartyNotices.md).

The distribution/documentation approach references [Cowart](https://github.com/zhongerxin/Cowart).
