#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(`Usage: tsx <script.ts> [args...]\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Repository-local tsx compatibility runner for Node.js 24+ erasable TypeScript.\n`);
  process.exit(0);
}

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
