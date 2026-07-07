import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));

function readText(...parts: string[]): string {
  return readFileSync(join(skillRoot, ...parts), 'utf8');
}

test('issue brief template requires an architecture fit section', () => {
  const template = readText('references', 'issue-brief-template.md');

  assert.match(template, /Architecture fit notes/);
  assert.match(template, /Relevant ADRs reviewed:/);
  assert.match(template, /Existing modules\/seams\/helpers reused:/);
  assert.match(template, /Existing modules intentionally not reused and why:/);
  assert.match(template, /ADR-owned seams that must not be bypassed or wrapped incorrectly:/);
  assert.match(template, /acceptable reuse through public surfaces versus forbidden seam bypassing:/);
});

test('workflow guidance requires a pre-implementation architecture-fit check and DRY review', () => {
  const skill = readText('SKILL.md');

  assert.match(skill, /Before implementation starts, perform an architecture-fit check:/);
  assert.match(skill, /read the relevant ADRs/);
  assert.match(skill, /record the outcome in the issue brief and lifecycle log/);
  assert.match(skill, /DRY and deep-module check/);
  assert.match(skill, /widened interfaces/);
  assert.match(skill, /accepted seams instead of bypassing or re-wrapping them/);
});

test('completion contract requires architecture and reuse notes in implementation artifacts', () => {
  const adr = readText('references', 'agent-run-completion-adr.md');

  assert.match(adr, /architectureNotes/);
  assert.match(adr, /reuseNotes/);
  assert.match(adr, /architecture\/reuse notes covering reused modules, intentionally not reused modules, new seams, and seam-bypass risks/);
  assert.match(adr, /DRY\/deep-module check/);
});
