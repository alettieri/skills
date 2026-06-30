import { loadWorkflow, WorkflowValidationError } from './workflow.ts';

function parseIssue(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--issue') {
      const value = argv[index + 1];
      if (!value || value.trim() === '') {
        throw new Error('--issue requires a value');
      }
      return normalizeIssueReference(value);
    }
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  throw new Error('missing required option --issue');
}

function normalizeIssueReference(value: string): string {
  const trimmed = value.trim();
  if (/^#?\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error('--issue must be an issue number, #number, or GitHub issue URL');
}

function printHelp(): void {
  process.stdout.write('Usage: dry-run.ts --issue <issue-number-or-url>\n');
}

function main(): void {
  const issue = parseIssue(process.argv.slice(2));
  const source = loadWorkflow(process.cwd());

  process.stdout.write(`Issue: ${issue}\n`);
  process.stdout.write(`Workflow: ${source.path}\n`);
  process.stdout.write(`Name: ${source.workflow.name}\n`);
  process.stdout.write(`Version: ${source.workflow.version}\n`);
  process.stdout.write(`Type: ${source.workflow.type}\n`);
  process.stdout.write(`Start: ${source.workflow.start}\n\n`);

  process.stdout.write('Normalized roles:\n');
  for (const [roleName, role] of Object.entries(source.workflow.roles)) {
    process.stdout.write(`- ${roleName}: ${JSON.stringify(role)}\n`);
  }

  process.stdout.write('\nPhases:\n');
  for (const [phaseName, phase] of Object.entries(source.workflow.phases)) {
    const role = typeof phase.role === 'string' ? ` role=${phase.role}` : '';
    process.stdout.write(`- ${phaseName}: type=${phase.type}${role}\n`);
  }

  process.stdout.write('\nNamed outcome transitions:\n');
  for (const transition of source.workflow.transitions) {
    process.stdout.write(`- ${transition.from}.${transition.outcome} -> ${transition.to}\n`);
  }

  process.stdout.write('\nTransition graph:\n');
  for (const [phaseName, phase] of Object.entries(source.workflow.phases)) {
    const targets = Object.entries(phase.on).map(([outcome, target]) => `${outcome}:${target}`);
    process.stdout.write(`- ${phaseName} -> ${targets.length > 0 ? targets.join(', ') : '(terminal)'}\n`);
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
