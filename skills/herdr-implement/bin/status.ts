import { parseArgs } from 'node:util';
import { formatLiveRunStatus, readLiveRunStatus } from '../src/status.ts';
import { optionalTrimmedString } from '../src/validation.ts';

function parseOptions(argv: string[]): { worktreePath: string } {
  const parsed = parseArgs({
    args: argv.slice(2),
    options: {
      worktree: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    worktreePath: optionalTrimmedString(parsed.values.worktree) ?? process.cwd(),
  };
}

function printHelp(): void {
  process.stdout.write('Usage: status.ts [--worktree <path>]\n');
}

function main(): void {
  const options = parseOptions(process.argv);
  const status = readLiveRunStatus(options.worktreePath);
  process.stdout.write(formatLiveRunStatus(status));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Status failed: ${message}\n`);
  process.exitCode = 1;
}
