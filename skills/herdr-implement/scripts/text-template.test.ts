import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTemplate } from './text-template.ts';

test('renderTemplate substitutes dotted, dashed, and underscored keys', () => {
  const rendered = renderTemplate('A {{ issue.number }} / {{ issue-input }} / {{ issue_name }}', {
    'issue.number': '42',
    'issue-input': 'from-input',
    issue_name: 'from-name',
  });

  assert.equal(rendered, 'A 42 / from-input / from-name');
});

test('renderTemplate trims placeholder whitespace and leaves missing keys empty', () => {
  const rendered = renderTemplate('Hello {{  present.key  }} and {{ missing.key }}!', {
    'present.key': 'there',
  });

  assert.equal(rendered, 'Hello there and !');
});

test('renderTemplate leaves non-placeholder text unchanged', () => {
  const rendered = renderTemplate('No substitutions here.', {});

  assert.equal(rendered, 'No substitutions here.');
});
