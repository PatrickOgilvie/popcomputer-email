# Changelog

All notable changes to `@popcomputer/email` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial Effect-native email domain, application services, adapters, hosted
  client, protocol, and testing support.
- `Identifiers` root namespace exposing the message, route, workflow, actor,
  namespace, idempotency-key and page-cursor schemas to hosts.
- `keyPrefix` option on `makeR2RawMessageArchive` and
  `r2RawMessageArchiveLayer`, so a host can archive under its own R2 prefix.
- `captureSendTransport` adapter for deployments without a mail provider;
  sends terminalize as `Captured`.
- `Inbound.Service.receive` returns the message together with a `replayed`
  flag; `ingest` keeps returning the message alone.

### Changed

- Effect peer range is `^4.0.0` (stable Effect 4, verified against `4.0.2`);
  postal-mime is `3.0.0`.
- Package version `0.2.0`.
