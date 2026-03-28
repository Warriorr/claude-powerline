# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # Compile TypeScript → dist/ (required after src/ changes)
npm run dev          # Watch mode build
npm run typecheck    # Type check without emitting
npm run lint         # Run ESLint
npm run lint:fix     # ESLint with auto-fix
npm test             # Run Jest test suite
npm run test:watch   # Watch mode tests
npm run test:coverage
npm start            # Run built dist/index.mjs
```

Releases use semantic-release (`.releaserc.json`); versioning is automated via conventional commits.

## Architecture

Claude Powerline is a zero-dependency TypeScript CLI that renders a configurable statusline for Claude Code, displayed via the `statusline` hook in Claude Code's `settings.json`.

**Data flow:** Claude Code hook events → `src/utils/claude.ts` (parse hook data) → segments (compute values) → `src/powerline.ts` (orchestrate rendering) → stdout (ANSI string consumed by Claude Code)

### Key layers

**`src/powerline.ts`** — `PowerlineRenderer` is the top-level class that wires together config, theme, and segments into the final output string.

**`src/segments/`** — Each file is a self-contained data provider:
- `session.ts` / `block.ts` / `today.ts` / `weekly.ts` — Usage tracking at different time windows (5-hour billing block, daily, weekly)
- `context.ts` — Context window % usage
- `git.ts` — Branch name, dirty state
- `pricing.ts` — Token-to-cost conversion via `pricing.json`
- `metrics.ts` — Performance timing
- `tmux.ts` — Tmux session detection
- `renderer.ts` — Renders a segment object into colored ANSI output

**`src/tui/`** — Alternative "TUI" display style: a bordered panel with responsive layout engine (`layouts.ts`). Separate from the inline powerline styles.

**`src/themes/`** — Built-in themes (dark, light, nord, tokyo-night, rose-pine, gruvbox) plus custom color support.

**`src/config/`** — `loader.ts` merges CLI flags, env vars, and `.claude-powerline.json` config file. `defaults.ts` defines all defaults.

**`src/utils/`** — Shared utilities: `colors.ts` (ANSI/hex conversion), `formatters.ts` (number/cost display), `budget.ts` (budget % calculations), `cache.ts`, `terminal.ts` (dimension detection), `logger.ts` (debug output).

### Display styles

Four styles exist: `minimal`, `powerline` (arrow separators), `capsule` (rounded separators), `tui` (bordered panel). Character sets: `unicode` (Nerd Font required) or `ascii`.

### Build tooling

- **tsdown** (`tsdown.config.ts`) — Bundles src/ → dist/index.mjs
- **Jest** (`jest.config.js`) — Tests live in `test/`, covering segments, config, formatters, colors, and git worktrees
- **ESLint flat config** (`eslint.config.mjs`) — TypeScript + Prettier integration
- **tsconfig.json** — ES2022 target, strict mode, ESNext modules

### Runtime integration

The built `dist/index.mjs` is invoked by Claude Code on each hook event. The local `.claude-powerline.json` configures the instance for this repo itself. After any `src/` change, `npm run build` is required before changes are reflected.
