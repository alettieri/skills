import { parseArgs } from 'node:util';
import { daemonStep, printDaemonStep, runDaemonLoop } from '../src/runtime.ts';
import { WorkflowValidationError } from '../src/workflow.ts';

function parseOptions(argv: string[]): { worktreePath?: string; statePath?: string; handleStatePath?: string; once: boolean } {
  const parsed = parseArgs({
    args: argv.slice(2),
    options: {
      worktree: { type: 'string' },
      state: { type: 'string' },
      handles: { type: 'string' },
      once: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    worktreePath: parsed.values.worktree,
    statePath: parsed.values.state,
    handleStatePath: parsed.values.handles,
    once: parsed.values.once ?? false,
  };
}

function printHelp(): void {
  process.stdout.write('Usage: daemon.ts [--state <path>] [--handles <path>] [--once]\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv);
  const runtimeOptions = {
    cwd: options.worktreePath,
    statePath: options.statePath,
    handleStatePath: options.handleStatePath,
  };

  if (options.once) {
    const result = daemonStep(runtimeOptions);
    process.stdout.write(`${printDaemonStep(result)}\n`);
    return;
  }

  await runDaemonLoop(runtimeOptions);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = error instanceof WorkflowValidationError ? 'Workflow validation failed' : 'Daemon failed';
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exitCode = 1;
}
