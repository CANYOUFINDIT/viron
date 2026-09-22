# Security Policy

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/CANYOUFINDIT/viron/security/advisories/new

Do not open public issues for credential exposure, authentication bypass,
remote code execution, or other high-impact findings.

Viron stores encrypted connection credentials and can open SSH, SFTP, database,
Redis, and browser sessions. Treat any deployed instance as sensitive.

When filing a report, include the affected version, reproduction steps, and
impact. Please allow time for a fix before public disclosure.

## Private material

Store all new private or sensitive material under the repository's `private/`
directory. This includes credentials, unredacted internal screenshots, internal
host and account information, data exports, backups, and private working notes.

`private/` must remain in `.gitignore`. Never stage, commit, or push its contents,
including with `git add -f`. Files ignored by Git are also excluded from material
intended for public release; do not attach private files to GitHub Releases or
issues.

Documentation must use fictitious data or fully redacted screenshots. Keep real
passwords, tokens, private keys, local environment files, and runtime databases
out of tracked files. Before committing documentation or screenshots, check
addresses, account names, log output, and local filesystem paths as well as
credentials.
