# Contributing

## Commit messages

Follow the convention documented in [CHANGELOG.md](CHANGELOG.md#commit-message-convention):

```
<type>: <subject>

<body explaining *why*>
```

Types: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`, `perf:`.
Subject ≤ 72 chars, imperative mood. Body explains why, not what.

## Tests

- Unit tests live next to source: `src/foo.ts` → `src/foo.test.ts`.
- Run the full suite before pushing: `npm test`.
- Network-dependent tests (link health, e2e) are opt-in:
  `npm run test:links` and `YAPPER_LINK_CHECK=1 npm test`.
- New engine code should add a mock `CustomEngine` to
  `engine.behavior.test.ts` rather than test the real model.
- Worker protocol helpers belong in `engines/worker-bridge.test.ts`;
  keep pure document helpers in `document-types` / reader tests so
  vitest does not pull pdfjs or tesseract into every file.

## Build / CI

- `npm run build` must stay clean. Warnings about chunk size are OK
  (we deliberately split heavy libs into their own chunks).
- `npm run lint` and `npm run typecheck` must both pass.
- A new `npm audit` vulnerability above `moderate` should ship a
  fix in the same PR that introduces the dependency.

## Architecture

- Pure helpers live in their own files (`document-types.ts`,
  `events.ts`) so unit tests don't pull in heavy libs
  (pdfjs, tesseract).
- Engine events go through `EventEmitter` (`engine.on()`), never by
  mutating `engine.events.*` directly. That pattern is deprecated.
- Custom TTS backends implement `CustomEngine` and register via
  `registerCustomEngine(modelId, …)`. Kokoro/Kitten are wrapped in
  `WorkerBackedEngine` from `src/engines/worker-bridge.ts`.
- Document ingestion for the UI is `document-reader.ts`; reading UX
  and highlight timing live in `reader.ts`. See
  [docs/architecture.md](docs/architecture.md).
