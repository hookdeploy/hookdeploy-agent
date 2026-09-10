# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-09-10

### Fixed

- Device enrollment that already finished (CLI `enrollment already completed`) now tells the user the original agent is enrolled and not to start a new one, instead of "start again" or a generic connection failure.

### Changed

- Bundled hookdeployed sidecar updated to 0.1.3.

## [0.1.2] - 2026-09-10

### Fixed

- Bundled hookdeployed sidecar updated to 0.1.2. A local server closing its connection mid-response could be silently recorded as a successful delivery instead of a failure.

### Changed

- README now points at the live Agent and CLI docs.

## [0.1.1] - 2026-09-05

### Fixed

- Enroll failures are classified and shown; clock skew and dead credentials are surfaced instead of a generic retry loop.

## [0.1.0] - 2026-09-03

First tagged release. Earlier history predates this changelog.

[Unreleased]: https://github.com/hookdeploy/hookdeploy-agent/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/hookdeploy/hookdeploy-agent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/hookdeploy/hookdeploy-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/hookdeploy/hookdeploy-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hookdeploy/hookdeploy-agent/releases/tag/v0.1.0
