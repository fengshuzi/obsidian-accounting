# AGENTS.md — coin-memo

Obsidian plugin for daily journal-based accounting (记账). Parses transaction entries from daily notes and provides statistics and export.

## Layout

Single-file plugin — `main.ts` is the only TypeScript source. Companion files:
- `manifest.json` / `versions.json` / `config.json` / `styles.css` / `esbuild.config.mjs` / `eslint.config.mjs` / `tsconfig.json`
- `deploy.mjs` / `release.mjs` / `version-bump.mjs` — maintainer scripts
- `test-parser.mjs` — standalone parser test
- `BUG.md` / `REVIEW-FIX-PROGRESS.md` — issue tracking

## Commands

```bash
npm run dev      # esbuild watch -> dist/main.js
npm run build    # lint + esbuild production
npm run lint     # eslint "**/*.{ts,tsx}"
npm run version  # bump version + git add manifest.json versions.json
npm run deploy   # build + copy to author's local vaults, then delete dist/
npm run release  # gh release create from manifest.json version
```

`build` enforces lint before bundling. No `tsc` typecheck in the build pipeline.

## Build

- esbuild, entry `main.ts`, format `cjs`, target `es2018`
- externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins
- Copies `manifest.json`, `styles.css`, `config.json`, and `assets/` to `dist/`
- **Post-build patch**: `esbuild.config.mjs` patches `html2canvas` dynamic script creation after bundling

## Build quirk

`html2canvas` creates dynamic `<script>` elements which violates Obsidian's CSP. The esbuild config contains a post-build string replacement to fix this. Do not remove the patch without testing PDF export.

## Versioning

- `version-bump.mjs` bumps `manifest.json` and `versions.json` automatically
- `release.mjs` reads version from `manifest.json`
- Keep `package.json` in sync manually

## Marketplace / Scorecard

Marketplace, manifest, and release conventions live in the parent `obsidian-plugins-parent/AGENTS.md`. Read it before touching `manifest.json`, release flow, or marketplace-facing code. Historical Scorecard fixes are recorded in `BUG.md` and `REVIEW-FIX-PROGRESS.md`.