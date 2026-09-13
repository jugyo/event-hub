# ADR 0002: Use macOS Keychain as the Initial Secret Backend

- Status: Accepted
- Date: 2026-09-10

## Context

A user LaunchAgent must retrieve only the secrets explicitly mapped to each plugin without interactive prompts. Secret values must not appear in command-line arguments, project configuration, manifests, plist files, logs, journals, or plaintext fallback files.

The initial candidates were macOS Keychain and the 1Password CLI. Apple's `security` command supports generic-password CRUD operations, but `security add-generic-password -w` without a value uses its own TTY prompt rather than standard input. Passing `-w <value>` would expose the value through process arguments.

We also considered a small Security framework helper, controlling `security` through a pseudo-terminal, and persistent temporary files. A pseudo-terminal depends on prompt synchronization and terminal echo behavior. Temporary files introduce unnecessary persistence risk. A Security framework helper can accept the value directly through standard input and explicitly disable authentication UI.

A locked Keychain normally requires authentication or an unlock action. A non-interactive LaunchAgent must treat that state as unavailable.

The 1Password desktop integration depends on the desktop app and interactive approval. Service accounts support non-interactive use but require an account, vault permissions, and a securely delivered service-account token.

References:

- [Apple: Lock your keychain on Mac](https://support.apple.com/guide/keychain-access/lock-keychains-kyca1120/mac)
- [Apple: security(1) manual page](https://keith.github.io/xcode-man-pages/security.1.html)
- [1Password CLI desktop app integration](https://developer.1password.com/docs/cli/app-integration/)
- [1Password service accounts](https://developer.1password.com/docs/service-accounts/use-with-1password-cli/)

## Decision

Use the logged-in user's default macOS Keychain. Derive the Keychain service name from a SHA-256 digest of the absolute project path and use the secret reference name as the account name. Project configuration stores only the reference name and the `keychain` backend type.

`secret add` and `secret update` read a value once from a hidden TTY prompt or standard input. For writes, event-hub compiles a temporary Security framework helper from bundled C source with `/usr/bin/clang` and passes the value only through the helper's standard input. The value never appears in arguments or temporary files. The non-secret helper and directory are removed afterward.

Reads use `security find-generic-password -w`, but its standard output is never forwarded to application output or diagnostics. The write helper uses `kSecUseAuthenticationUIFail` so it never opens authentication UI.

A locked Keychain, denied access, unavailable `security`, or missing `/usr/bin/clang` produces the fixed `UNAVAILABLE` error without starting an interactive fallback. Only the affected plugin invocation fails. There is no automatic unlock, plaintext cache, or environment-variable fallback.

## Consequences

- Initial operation requires no third-party service.
- Writes require Apple Command Line Tools; reads and deletes use `/usr/bin/security`.
- Moving a project changes its Keychain namespace. Automatic migration is out of scope.
- Availability while the screen is locked depends on the user's Keychain auto-lock and item access-control settings.
- 1Password can be added later as a separate backend.

## Opt-in Keychain test

Normal tests use a fake backend and never modify the real Keychain. Run the integration test only in an environment where a temporary secret may be created, updated, and deleted:

```console
npm run test:keychain
```

The test uses a unique `EH_OPT_IN_<pid>` item and attempts cleanup on both success and failure. To test the locked state, lock the relevant Keychain manually, verify that the command fails without exposing the value, and unlock it manually afterward. Automated tests never lock, unlock, read, or modify unrelated Keychain items.
