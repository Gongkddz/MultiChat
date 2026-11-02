# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Gongkddz/MultiChat/security/advisories/new). Do not publish keys or private conversations in issues.

The Windows app binds to `127.0.0.1:8765`, rejects non-loopback hosts and cross-origin requests, and sanitizes model Markdown. The local API is not an authentication boundary against other processes running as your Windows user. Do not expose it through a tunnel or reverse proxy.

API keys and conversations are saved under `%LOCALAPPDATA%/NVIDIAChat/`. Saved keys are local JSON configuration, **not encrypted**. Protect your Windows account and never upload this directory. Conversation exports omit API keys but may contain private content. Selected history, project instructions and attachments are sent to the selected provider. This app has no telemetry or project-operated proxy.

Security updates target the latest release. Downloads are unsigned; verify SHA-256 checksums.
