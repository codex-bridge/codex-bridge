# Security Policy

## Supported versions

Security fixes are applied to the latest public release and the current `main`
branch. Older releases may no longer receive fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting from the repository's **Security**
tab. Include the affected version, impact, reproduction steps, and any suggested
mitigation. Do not include credentials, private Codex conversations, or other
sensitive user data.

If private vulnerability reporting is not available, open a minimal public
issue asking for a private contact channel. Do not publish exploit details in
the issue.

Please allow maintainers time to reproduce and address the report before public
disclosure.

## Deployment boundary

Codex Bridge is intended for self-hosted, single-user or trusted-team use. The
Web UI does not provide an internet-facing account or authentication layer.
Bind it to loopback or a trusted LAN address, and use a VPN for remote access.
Do not expose the service directly to the public internet.

Telegram and Slack credentials, Codex authentication, provider credentials,
runtime databases, attachments, and environment files must remain outside
version control. A Bridge process should run as the same operating-system user
that owns the Codex configuration it is allowed to access.
