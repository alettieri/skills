import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function firstExistingPath(paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function resolveWorkflowRoot(workflowPath: string): { workflowDir: string; workflowRoot: string } {
  const workflowDir = dirname(resolve(workflowPath));
  return {
    workflowDir,
    workflowRoot: dirname(workflowDir),
  };
}

function stripWorkflowScriptPrefix(command: string): string {
  return command.startsWith('workflow-scripts/') ? command.slice('workflow-scripts/'.length) : command;
}

export function readWorkflowScriptSource(cwd: string, workflowPath: string, command: string): { path: string; source: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('script command must be a non-empty string');
  }

  if (resolve(trimmed) === trimmed && existsSync(trimmed)) {
    return { path: trimmed, source: readFileSync(trimmed, 'utf8') };
  }

  const { workflowDir, workflowRoot } = resolveWorkflowRoot(workflowPath);
  const builtInRoot = resolve(cwd, 'skills/herdr-implement');
  const overrideName = stripWorkflowScriptPrefix(trimmed);
  const resolvedPath = firstExistingPath([
    resolve(cwd, '.agent/workflow-scripts', overrideName),
    resolve(workflowDir, trimmed),
    resolve(workflowRoot, trimmed),
    resolve(cwd, trimmed),
    resolve(builtInRoot, trimmed),
  ]);

  if (!resolvedPath) {
    throw new Error(`script command does not exist: ${command}`);
  }

  return {
    path: resolvedPath,
    source: readFileSync(resolvedPath, 'utf8'),
  };
}

export function readPromptTemplateSource(cwd: string, workflowPath: string, templateName: string): { path: string; source: string } {
  const trimmed = templateName.trim();
  if (!trimmed) {
    throw new Error('prompt template must be a non-empty string');
  }

  if (resolve(trimmed) === trimmed && existsSync(trimmed)) {
    return { path: trimmed, source: readFileSync(trimmed, 'utf8') };
  }

  const { workflowDir, workflowRoot } = resolveWorkflowRoot(workflowPath);
  const builtInRoot = resolve(cwd, 'skills/herdr-implement');
  const resolvedPath = firstExistingPath([
    resolve(cwd, '.agent/prompts', trimmed),
    resolve(workflowDir, 'prompts', trimmed),
    resolve(workflowRoot, 'prompts', trimmed),
    resolve(cwd, 'prompts', trimmed),
    resolve(builtInRoot, 'prompts', trimmed),
  ]);

  if (!resolvedPath) {
    throw new Error(`prompt template does not exist: ${templateName}`);
  }

  return {
    path: resolvedPath,
    source: readFileSync(resolvedPath, 'utf8'),
  };
}
