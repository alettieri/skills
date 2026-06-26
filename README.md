# Skills Repository

## Setup

This repository stores Codex skills. Install all local skills into the global agent directory with:

```bash
./scripts/link-skills.sh
```

### Useful options

- `SKILLS_DIR`: override the source skills directory
  - Example: `SKILLS_DIR=/path/to/skills ./scripts/link-skills.sh`
- `AGENTS_DIR`: override the destination directory
  - Example: `AGENTS_DIR=$HOME/.agents/skills ./scripts/link-skills.sh`
