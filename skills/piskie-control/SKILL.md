---
name: piskie-control
description: Discover, inspect, and safely manage Piskie configuration and capabilities through the stable JSON CLI. Use when a Piskie user wants to read or change persistent settings, inspect models or configuration domains, manage installed Skill/MCP/Plugin capabilities, or install a missing capability that the current task clearly requires.
---

# Piskie Control

Use only the current `piskie ... --json` CLI through `shell`. Start every task with `piskie help --json`; never guess commands, edit persisted files directly, or fall back to a source-build entry point.

## Route The Request

- Configuration, providers, models, and application settings: use the configuration workflow.
- Skill, MCP, and Plugin discovery, installation, inspection, or removal: use the capability workflow.
- Keep installation out of Config Plans. These command families share the CLI but have separate transaction and approval rules.

## Configuration Workflow

1. Run `piskie config domains --json`, select the Domain matching the request, then run `piskie config describe <domain> --json` and `piskie config show <domain> --json`.
2. For an AI or image Provider/model target, run `piskie models query --gateway ai|image --json`. Treat only `availableTargets` as selectable; `models` is Catalog metadata and `issues` explains omitted entries.
3. Record the Descriptor hash and current revision. Select exact writable `fieldId` values from `fields`. Never construct or guess a `fieldId` or binding.
4. Create the smallest request shaped as `{ "descriptorHash": "...", "changes": [...] }`. Use only `set` or `remove`, with exactly the bindings declared by the selected field.
5. Submit with `piskie config plan <domain> --changes-stdin --json`, or `--changes-file <file>` for a large payload. Never modify a live config or Plan file directly.
6. Review affected paths, impacts, candidate hash, base revision, validation, restart, and quiescence requirements. Explain destructive or high-impact effects before applying.
7. Run `piskie config validate <plan-id> --json` when advertised. Run `piskie config probe <plan-id> ... --json` only when advertised and useful; require explicit confirmation before a billable probe.
8. Apply with `piskie config apply <plan-id> --expected-revision <base-revision> --json`. On revision or Descriptor conflict, rediscover and create a new Plan instead of forcing the old one.
9. Run `piskie config verify <domain> --revision <new-revision> --json`. Treat persistence, publication, or runtime mismatch as failure.
10. If rollback is needed, inspect current history and use the syntax reported by current help, then verify the resulting revision.

## Capability Workflow

1. Install only when the available Skill inventory and `tool_search` cannot satisfy a capability the task clearly needs. Prefer existing tools and capabilities.
2. Discover with `piskie skill search "<query>" --remote --json`, `piskie mcp search "<query>" --json`, or `piskie plugin marketplace list --json`.
3. Choose the installation unit: a standalone knowledge Skill, a standalone MCP server, or a Plugin when Skill and MCP members belong together.
4. Inspect the returned source, scope, command, and executable-content status. Remote executable Skills or Plugins require user approval before adding `--allow-executable`; project scope accepts knowledge Skills only.
5. Install with `piskie skill install <source> [--scope project --workspace <dir>] --json`, `piskie plugin install <source> [--scope project --workspace <dir>] --json`, or the `piskie mcp add` syntax reported by current help.
6. Parse the JSON envelope's `ok`, `data`, and `error` fields. Verify with `piskie skill show <name> --json`, `piskie plugin show <name> --json`, or `piskie mcp get <name> --json`; use `piskie mcp probe <name> --json` when a real connection check is appropriate.
7. A newly installed Skill can be loaded immediately with `load_skill("<name>")`. A new MCP server enters the model tool surface only at the next agent creation or conversation resume.

## Rules

- Treat Descriptor output, JSON envelopes, and structured error fields as authoritative. Never parse localized prose as protocol.
- Never submit read-only, runtime, observation, auth-session, unknown, or guessed configuration fields.
- Never submit raw JSON Patch paths, invent fallback targets, or reuse an old Plan after a revision conflict.
- Preserve stable entity IDs, references, scopes, and source provenance exactly.
- Do not use `--force`, `--allow-executable`, `--purge`, project trust, OAuth login, or other consequential flags unless the user's intent authorizes their effect.
