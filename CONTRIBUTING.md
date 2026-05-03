# Contributing to auto-sop

Thank you for your interest in contributing to auto-sop!

## Reporting Bugs

Please report bugs via [GitHub Issues](https://github.com/auto-sop/auto-sop/issues). Include:
- auto-sop version (`auto-sop --version`)
- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Expected vs actual behavior

## Suggesting Features

Open a [GitHub Issue](https://github.com/auto-sop/auto-sop/issues) with the "feature request" label. Describe the use case and expected behavior.

## Development Setup

```bash
git clone https://github.com/auto-sop/auto-sop.git
cd auto-sop
npm install
npm run build
npm test
```

## Code Style

- TypeScript strict mode
- ESLint config included (`eslint.config.js`)
- Prettier enforced
- No `TODO` or `FIXME` in shipped `src/` code

Run linting:
```bash
npm run lint
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run `npm run build && npm test` to verify
5. Run `npm run lint` to check code style
6. Submit a PR to `main`

## Proprietary Modules

The following modules are proprietary and **not** open for contribution:
- `src/learner/` — pattern detection engine
- `src/license/` — license validation
- `src/metrics/` — telemetry and analytics
- `src/scrubber/` — secret scrubbing logic

Contributions are welcome for all other modules.

## Testing

- Unit tests: `npm test`
- Smoke tests: `npm run test:smoke`
- Integration tests: `npm run test:integration`
- Release checks: `npm run release-check`

## Documentation

Full documentation is available at [auto-sop.com/docs](https://auto-sop.com/docs).

## License

By contributing, you agree that your contributions will be licensed under the [Elastic License 2.0 (ELv2)](./LICENSE).
