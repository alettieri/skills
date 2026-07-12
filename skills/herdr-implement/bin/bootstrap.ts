import { parseArgs } from 'node:util';
import { bootstrap, BootstrapError, printBootstrapSummary } from '../src/runtime.ts';
import { WorkflowValidationError } from '../src/workflow.ts';
import { optionalTrimmedString } from '../src/validation.ts';

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
  const issue = optionalTrimmedString(value);
  if (!issue) {
    throw new Error('missing required option --issue');
  }

  return issue;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: HERDR_ENV=1 bootstrap.ts --issue <issue-reference>',
    '',
    'Side effects:',
    '- creates or reuses a Herdr worktree',
    '- launches or recovers the daemon pane',
    '- hands lifecycle control to the daemon, which may commit, push, and open a PR',
    '',
    'Use dry-run.ts for read-only workflow inspection.',
    '',
  ].join('\n'));
}

function requireHerdrEnv(): void {
  if (process.env.HERDR_ENV !== '1') {
    throw new Error('HERDR_ENV=1 is required to bootstrap a worktree and daemon; use --help for the side effects.');
  }
}

function printBootstrapDiagnostics(result: Awaited<ReturnType<typeof bootstrap>>): void {
  process.stderr.write(
    `${JSON.stringify(
      {
        issue: result.issue.canonical,
        slug: result.slug,
        mode: result.mode,
        health: result.health,
        currentPhase: result.currentPhase,
        worktreePath: result.worktreePath,
        workspaceId: result.workspaceId,
        branchName: result.branchName,
        daemonTabId: result.daemonTabId,
        daemonPaneId: result.daemonPaneId,
        runStatePath: result.runStatePath,
        handleStatePath: result.handleStatePath,
        reason: result.health === 'timed-out' ? 'no state progress in 30s' : 'pane-exited',
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const issue = parseIssue(process.argv);
  requireHerdrEnv();
  const result = await bootstrap({ issue });

  process.stdout.write(`${printBootstrapSummary(result)}\n`);
  if (result.health !== 'healthy') {
    printBootstrapDiagnostics(result);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = error instanceof WorkflowValidationError ? 'Workflow validation failed' : error instanceof BootstrapError ? 'Bootstrap failed' : 'Bootstrap failed';
  process.stderr.write(`${prefix}: ${message}\n`);
  if (error instanceof BootstrapError && error.diagnostics) {
    process.stderr.write(`${JSON.stringify(error.diagnostics, null, 2)}\n`);
  }
  process.exitCode = 1;
}
