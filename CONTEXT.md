# Skills

This repository defines reusable skills and their supporting workflow language.

## Language

**Workflow Script**:
An executable command invoked by a workflow `script` or `poll` phase. Built-in Workflow Scripts can be copied or overridden by a project-specific repository.
_Avoid_: Shell script, helper script, runtime script

**Workflow Script Override**:
A project-specific Workflow Script placed under `.agent/workflow-scripts/` to replace the built-in command for that project.
_Avoid_: Custom script, local helper

**Prompt Override**:
A project-specific prompt template placed under `.agent/prompts/` to replace a built-in prompt for that project.
_Avoid_: Custom prompt, local prompt

**Command Entrypoint**:
A thin TypeScript executable that parses process arguments, calls orchestration code, and handles process exit behavior.
_Avoid_: Runtime script, CLI helper

**Skill Test Harness**:
The test suite for a skill, kept outside production source and executable asset directories.
_Avoid_: Inline tests, script tests
