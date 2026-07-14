import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  normalizeCheckResultsPayload,
  normalizePullRequestPayload,
} from './pr-monitor-domain.ts';
import type { CheckResult, PullRequestPayload } from './pr-monitor-domain.ts';

type CommandResult = SpawnSyncReturns<string>;

export type PrHostProvider = {
  name: string;
  fetchPullRequest(prRef: string | null, repo: string | null): PullRequestPayload;
  fetchChecks(prRef: string | null, repo: string | null): CheckResult[];
};

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

function runGhChecksJson(args: string[], repo: string | null): unknown {
  const result = runGh(args, repo);
  if (result.status === 1 && result.stderr.trim().includes('no checks reported')) {
    process.stderr.write(`pr-host-provider gh checks normalized empty: ${result.stderr.trim()}\n`);
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

function fetchPullRequest(prRef: string | null, repo: string | null): PullRequestPayload {
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
  if (prRef) {
    prViewArgs.push(prRef);
  }
  prViewArgs.push('--json', prFields);

  return normalizePullRequestPayload(runGhJson(prViewArgs, repo));
}

function fetchChecks(prRef: string | null, repo: string | null): CheckResult[] {
  const checksArgs = ['pr', 'checks'];
  if (prRef) {
    checksArgs.push(prRef);
  }
  checksArgs.push('--json', 'bucket,state,name,workflow,description,link');

  return normalizeCheckResultsPayload(runGhChecksJson(checksArgs, repo));
}

const githubCliProvider: PrHostProvider = {
  name: 'github',
  fetchPullRequest,
  fetchChecks,
};

export function createPrHostProvider(name?: string | null): PrHostProvider {
  const providerName = name ?? 'github';
  if (providerName === 'github') {
    return githubCliProvider;
  }

  throw new Error(`Unknown PR host provider: ${providerName}`);
}
