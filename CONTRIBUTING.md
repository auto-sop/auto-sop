# Contributing to auto-sop

Thank you for your interest in contributing to auto-sop!

## Development Setup

```bash
git clone https://github.com/ugurgokdere/auto-sop.git
cd auto-sop
npm install
npm run build
npm test
```

## Version Bump Convention

Every plan/PR that ships code **must** bump the patch version before its final commit:

```bash
npm run version:bump-patch
```

This runs `npm version patch --no-git-tag-version`, which updates `package.json` (and `package-lock.json` if present) without creating a git tag. Tags are created only during the release workflow.

### Why?

- Every merged change gets a unique version number.
- The publish workflow (`publish.yml`) matches the `package.json` version to the git tag.
- Forgetting the bump means the release pipeline rejects the publish.

## Workflow

1. Create a feature branch from `master`.
2. Make your changes.
3. Run `npm run build && npm test` to verify.
4. Run `npm run lint` to check code style.
5. Run `npm run release-check` before opening a PR (some checks require a clean tree and built dist).
6. Bump the version: `npm run version:bump-patch`.
7. Commit and push.

## Code Style

- TypeScript strict mode.
- ESLint + Prettier enforced.
- No `TODO` or `FIXME` in shipped `src/` code.

## Testing

- All tests must pass: `npm test`
- Smoke tests: `npm run test:smoke`
- Benchmarks: `npm run bench:shim:ci`

## Release Checklist

Run `npm run release-check` to verify all 28 pre-publish checks pass. See `scripts/release-check.sh` for the full list.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
