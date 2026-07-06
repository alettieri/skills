import { parseArgs } from 'node:util';
import { bootstrap, printBootstrapSummary } from './runtime.ts';
import { WorkflowValidationError } from './workflow.ts';
import { optionalTrimmedString } from './validation.ts';

function parseIssue(argv: string[]): string {
  const parsed = parseArgs({
    args: argv.slice(2),
    options: {
      issue: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  return requireIssue(parsed.values.issue);
}

function requireIssue(value: string | undefined): string {
  if (!optionalTrimmedString(value)) {
    throw new Error('missing required option --issue');
  }

  return value as string;
}

function printHelp(): void {
  process.stdout.write('Usage: bootstrap.ts --issue <issue-number-or-url>\n');
}

async function main(): Promise<void> {
  const issue = parseIssue(process.argv);
  const result = bootstrap({ issue });

  process.stdout.write(`${printBootstrapSummary(result)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = error instanceof WorkflowValidationError ? 'Workflow validation failed' : 'Bootstrap failed';
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exitCode = 1;
}
