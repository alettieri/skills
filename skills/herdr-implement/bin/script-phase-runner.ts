import { runScriptPhaseRunner } from '../src/script-phase-runner.ts';

try {
  await runScriptPhaseRunner(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
