import { parseArgs } from 'node:util';
import { loadWorkflow, WorkflowValidationError } from '../src/workflow.ts';
import { normalizeIssueReference } from '../src/runtime.ts';
import { optionalTrimmedString } from '../src/validation.ts';
import type { IssueReference } from '../src/workflow-state-store.ts';

function parseIssue(argv: string[]): IssueReference {
  const parsed = parseArgs({
    args: argv.slice(2),
    options: {
      issue: {
        type: 'string',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
  });

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  return normalizeIssueReference(requireIssue(parsed.values.issue));
}

function requireIssue(value: string | undefined): string {
  const issue = optionalTrimmedString(value);
  if (!issue) {
    throw new Error('missing required option --issue');
  }

  return issue;
}

function printHelp(): void {
  writeLine('Usage: dry-run.ts --issue <issue-reference>');
}

function writeLine(line = ''): void {
  console.log(line);
}

function main(): void {
  const issue = parseIssue(process.argv);
  const source = loadWorkflow(process.cwd());

  writeLine(`Issue input: ${issue.input}`);
  writeLine(`Issue canonical: ${issue.canonical}`);
  writeLine(`Issue slug: ${issue.slug}`);
  if (issue.url) {
    writeLine(`Issue URL: ${issue.url}`);
  }
  writeLine(`Workflow: ${source.path}`);
  writeLine(`Name: ${source.workflow.name}`);
  writeLine(`Version: ${source.workflow.version}`);
  writeLine(`Type: ${source.workflow.type}`);
  writeLine(`Start: ${source.workflow.start}`);
  writeLine();

  writeLine('Normalized roles:');
  for (const [roleName, role] of Object.entries(source.workflow.roles)) {
    writeLine(`- ${roleName}: ${JSON.stringify(role)}`);
  }

  writeLine();
  writeLine('Phases:');
  for (const [phaseName, phase] of Object.entries(source.workflow.phases)) {
    const role = typeof phase.role === 'string' ? ` role=${phase.role}` : '';
    writeLine(`- ${phaseName}: type=${phase.type}${role}`);
  }

  writeLine();
  writeLine('Named outcome transitions:');
  for (const transition of source.workflow.transitions) {
    writeLine(`- ${transition.from}.${transition.outcome} -> ${transition.to}`);
  }

  writeLine();
  writeLine('Transition graph:');
  for (const [phaseName, phase] of Object.entries(source.workflow.phases)) {
    const targets = Object.entries(phase.on).map(([outcome, target]) => `${outcome}:${target}`);
    writeLine(`- ${phaseName} -> ${targets.length > 0 ? targets.join(', ') : '(terminal)'}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = error instanceof WorkflowValidationError ? 'Workflow validation failed' : 'Dry run failed';
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exit(1);
}
