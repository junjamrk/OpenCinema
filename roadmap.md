# Roadmap

OpenCinema is building a local-first video studio that an AI agent can operate, from storyboard to final cut.

**Status: 0.4.0 is in development.** The priorities below describe our direction, not release dates. Features on `main` are not the same as a verified release. See the [changelog](changelog.md) for implemented changes and the [release guide](docs/releaseGuide.md) for packaging.

## Available in development

The current foundation includes:

- A Go server and React canvas with nodes, groups, connections, undo/redo, and local project files.
- MCP tools for host agents, including Codex and Claude Code. Manual actions and agent calls share the same editing tools.
- Image, video, and audio generation through configured providers, local services, and imported ComfyUI workflows.
- Image and media editing, Blockout previs, motion analysis, and video depth references.
- Shot plans, candidate review, edit plans, and single-shot replacement.

These capabilities have limits. Canvas tools require an open workbench page. Provider support, host integration, and output quality need separate verification. See [Known limitations](readmeEn.md#known-limitations).

## Current focus: a dependable 0.4.0 release

Make the first complete project reliable before expanding the feature list.

- [ ] Verify the full host loop: select nodes, send an instruction, apply the agent's edits, undo/redo, save, and reopen the project.
- [ ] Publish platform-specific release packages with clear installation steps and a verified host/provider compatibility matrix.
- [ ] Improve recovery from disconnects, interrupted downloads, service restarts, and unknown task results without submitting duplicate paid generations.
- [ ] Polish canvas and editor interactions, media previews, progress states, and actionable error messages.
- [ ] Publish a reproducible multi-shot example with its project, references, provider settings, and final film.

**Ready when:** a creator can install a package, finish that example through both manual and agent operations, and reopen the saved project with its outputs intact.

## Next: better films, one shot at a time

Help creators improve a whole sequence rather than collect disconnected generated clips.

- [ ] Keep character, vehicle, setting, screen direction, and camera intent consistent across shot plans and references.
- [ ] Make RGB, depth, and motion references easier to inspect and assign, with clear feedback when a model cannot use them.
- [ ] Compare candidate takes and adjacent shots before approval; carry review notes into a targeted revision.
- [ ] Regenerate or replace one shot while preserving approved shots, edit points, and reference history.
- [ ] Support longer sequences and richer audio editing while keeping the final cut connected to its source shots.

**Ready when:** a creator can identify a continuity problem, revise only the affected shot, and render a new complete film without rebuilding the sequence. Previs remains a reference; visual quality is judged from the actual footage.

## Next: a reusable model and workflow ecosystem

Use existing generation tools through one consistent workflow.

- [ ] Publish curated ComfyUI examples with documented model dependencies, input mappings, output formats, and supported versions.
- [ ] Improve workflow import diagnostics, parameter controls, cancellation, and recovery when a backend loses its task history.
- [ ] Expand provider manifests and local backend examples so new services can connect without changing the workbench.
- [ ] Document which reference roles each model supports before a generation is submitted.

## Longer term: an open workbench for people and agents

- [ ] Broaden verified MCP host coverage and keep selection, tools, edits, and results consistent across supported hosts.
- [ ] Improve plugin discovery, installation, upgrades, compatibility reporting, and permission visibility.
- [ ] Strengthen shared-project collaboration, reconnect behavior, and each participant's undo history.
- [ ] Improve project portability and reusable shot, reference, and workflow presets.

These are planned directions. Plugin sandboxing, unattended canvas execution, and hosted collaboration are not current guarantees.

## Help shape the roadmap

Open an [issue](https://github.com/junjamrk/OpenCinema/issues) with the film or workflow you are trying to finish, what blocks you, and the result you expect. Include your host and provider when relevant. Do not include API keys or private media.

Contributions are welcome through the [contribution guide](contributing.md). Scope and implementation details belong in linked issues and pull requests.
