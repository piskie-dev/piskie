import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = fs.readFileSync(
  new URL('../../../../skills/piskie-control/SKILL.md', import.meta.url),
  'utf8',
);

describe('piskie-control skill contract', () => {
  it('uses runtime discovery instead of fixed configuration knowledge', () => {
    for (const command of [
      'config domains',
      'config describe <domain>',
      'config show <domain>',
      'models query --gateway',
      'config plan <domain>',
      'config validate <plan-id>',
      'config probe <plan-id>',
      'config apply <plan-id>',
      'config verify <domain>',
    ]) {
      expect(skill).toContain(command);
    }

    expect(skill).not.toMatch(/piskie config (?:describe|show|plan|verify|rollback) inference/);
    expect(skill).not.toMatch(/\b(?:openai|anthropic|comfyui|baidu|dashscope|gemini)\b/i);
    expect(skill).not.toMatch(/piskie (?:selections|catalog|drivers|workflows)\b/);
    expect(skill).not.toMatch(/\b(?:encrypt(?:ed|ion)?|masked|presence-only|redact(?:ed|ion)?|secret-reference)\b/i);
  });

  it('discovers and manages capabilities through the stable JSON CLI', () => {
    for (const command of [
      'skill search "<query>" --remote --json',
      'mcp search "<query>" --json',
      'plugin marketplace list --json',
      'skill install <source>',
      'plugin install <source>',
      'mcp add',
      'skill show <name> --json',
      'plugin show <name> --json',
      'mcp get <name> --json',
      'mcp probe <name> --json',
    ]) {
      expect(skill).toContain(command);
    }
    expect(skill).toContain('Remote executable Skills or Plugins require user approval');
    expect(skill).toContain('project scope accepts knowledge Skills only');
    expect(skill).toContain('next agent creation or conversation resume');
    expect(skill).not.toContain('$CODEX_HOME');
  });

  it('forbids direct persistence edits and unconfirmed billable probes', () => {
    expect(skill).toContain('Never modify a live config or Plan file directly');
    expect(skill).toMatch(/require explicit confirmation before a billable probe/i);
    expect(skill).toContain('Never construct or guess a `fieldId`');
    expect(skill).toContain('--changes-stdin');
    expect(skill).toContain('--changes-file');
    expect(skill).toContain('Never submit raw JSON Patch paths');
    expect(skill).not.toContain('--patch-file');
    expect(skill).not.toContain('--patch-json');
  });
});
