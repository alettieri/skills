#!/usr/bin/env -S tsx

import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  HelpRequested,
  classifySnapshot,
  formatNotificationBody,
  formatText,
  maxTimestamp,
  normalizeBaselineFingerprint,
  normalizeCheckResultsPayload,
  normalizePullRequestPayload,
  parseArgs,
  normalizeHerdrPaneId,
} from './pr-monitor-domain.ts';
import type { MonitorArgs, MonitorReport } from './pr-monitor-domain.ts';

type CommandResult = ReturnType<typeof spawnSync>;

export function printHelp(): void {
  process.stdout.write(`Usage: pr-monitor.ts [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --pr <ref>          PR number, URL, or branch name. Defaults to current branch.\n`);
  process.stdout.write(`  --repo <owner/repo> GitHub repository override for gh.\n`);
  process.stdout.write(`  --interval <sec>    Poll interval in seconds. Default: 30.\n`);
  process.stdout.write(`  --state-file <path> Write the latest snapshot to a JSON state file.\n`);
  process.stdout.write(`  --notify-target <target>\n`);
  process.stdout.write(`                      Send one Herdr notification to the target when the PR becomes actionable or terminal.\n`);
  process.stdout.write(`  --json              Emit JSON lines.\n`);
  process.stdout.write(`  --text              Emit human-readable lines. Default.\n`);
  process.stdout.write(`  --quiet             Only emit when the snapshot changes.\n`);
  process.stdout.write(`  --once              Take one snapshot and exit.\n`);
  process.stdout.write(`  -h, --help          Show this help.\n`);
}

function ghBaseArgs(repo: string | null): string[] {
  return repo ? ['-R', repo] : [];
}

function runGh(args: string[], repo: string | null): CommandResult {
  const result = spawnSync('gh', [...ghBaseArgs(repo), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error('gh is not installed or not on PATH');
    }
    throw result.error;
  }

  return result;
}

function runGhJson(args: string[], repo: string | null, acceptableStatuses = new Set([0])): unknown {
  const result = runGh(args, repo);
  if (result.status === null || !acceptableStatuses.has(result.status)) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout) as unknown;
}

function isNoChecksReportedResult(result: CommandResult): boolean {
  return result.status === 1 && result.stderr.trim().includes('no checks reported');
}

function runGhChecksJson(args: string[], repo: string | null): unknown {
  const result = runGh(args, repo);
  if (isNoChecksReportedResult(result)) {
    return [];
  }
  if (result.status === null || !new Set([0, 8]).has(result.status)) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout) as unknown;
}

function runHerdr(args: string[], acceptableStatuses = new Set([0])): CommandResult {
  const result = spawnSync('herdr', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error('herdr is not installed or not on PATH');
    }
    throw result.error;
  }

  if (result.status === null || !acceptableStatuses.has(result.status)) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(`herdr ${args.join(' ')} failed with exit ${result.status}: ${stderr}`);
  }

  return result;
}

function runHerdrJson(args: string[]): unknown {
  const result = runHerdr(args);
  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout) as unknown;
}

async function writeStateFile(stateFile: string | null, report: MonitorReport): Promise<void> {
  if (!stateFile) {
    return;
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const tmpFile = `${stateFile}.tmp`;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(tmpFile, json, 'utf8');
  await rename(tmpFile, stateFile);
}

function loadBaselineFingerprint(stateFile: string | null): string | null {
  if (!stateFile) {
    return null;
  }

  try {
    const raw = readFileSync(stateFile, 'utf8');
    return normalizeBaselineFingerprint(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function snapshot(args: MonitorArgs): Promise<MonitorReport> {
  const prFields = [
    'number',
    'url',
    'state',
    'mergedAt',
    'closedAt',
    'reviewDecision',
    'updatedAt',
    'title',
    'comments',
    'reviews',
  ].join(',');

  const prViewArgs = ['pr', 'view'];
  if (args.prRef) {
    prViewArgs.push(args.prRef);
  }
  prViewArgs.push('--json', prFields);

  const pr = normalizePullRequestPayload(runGhJson(prViewArgs, args.repo));
  const checks = normalizeCheckResultsPayload(
    runGhChecksJson(
      ['pr', 'checks', ...(args.prRef ? [args.prRef] : []), '--json', 'bucket,state,name,workflow,description,link'],
      args.repo,
    ),
  );

  return classifySnapshot({
    prNumber: pr.number,
    prUrl: pr.url,
    title: pr.title,
    state: pr.state,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    reviewDecision: pr.reviewDecision,
    commentCount: pr.comments.length,
    reviewCount: pr.reviews.length,
    latestCommentAt: maxTimestamp(pr.comments.map((comment) => comment.createdAt)),
    latestReviewAt: maxTimestamp(pr.reviews.map((review) => review.submittedAt)),
    checks,
  });
}

async function sendNotification(target: string, body: string): Promise<void> {
  runHerdr(['agent', 'send', target, body]);
  const paneId = normalizeHerdrPaneId(runHerdrJson(['agent', 'get', target]));

  if (paneId) {
    runHerdr(['pane', 'send-keys', paneId, 'Return']);
    return;
  }

  throw new Error(
    `herdr send target ${target} has no pane_id; cannot send Return.\n`
    + 'Use a concrete Herdr agent target from `herdr agent list`.',
  );
}

async function main(): Promise<void> {
  let args: MonitorArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      printHelp();
      process.exit(0);
    }
    throw error;
  }

  const baselineFingerprint = loadBaselineFingerprint(args.stateFile);
  let lastFingerprint = baselineFingerprint;
  const notifyMode = Boolean(args.notifyTarget);

  while (true) {
    const report = await snapshot(args);
    if (!notifyMode && (report.fingerprint !== lastFingerprint || !args.quiet)) {
      const payload = args.output === 'json' ? JSON.stringify(report) : formatText(report);
      process.stdout.write(`${payload}\n`);
      lastFingerprint = report.fingerprint;
    }

    if (notifyMode) {
      if (report.actionRequired || report.terminal) {
        await writeStateFile(args.stateFile, report);
        const body = formatNotificationBody(report, args.stateFile);
        await sendNotification(args.notifyTarget as string, body);
        process.exit(0);
      }
    } else {
      await writeStateFile(args.stateFile, report);

      if (report.terminal || args.once) {
        process.exit(0);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryPoint && import.meta.url === entryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

export {
  classifySnapshot,
  formatNotificationBody,
  formatText,
  maxTimestamp,
  normalizeCheckResultsPayload,
  normalizeHerdrPaneId,
  normalizePullRequestPayload,
  parseArgs,
  summarizeChecks,
} from './pr-monitor-domain.ts';
