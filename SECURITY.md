# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in Primer, please report it through GitHub's [private vulnerability reporting](https://github.com/agershman/primer/security/advisories/new) rather than opening a public issue.

I aim to acknowledge reports within **7 days** and provide a fix or mitigation timeline within **30 days** for confirmed issues.

## What's in scope

- The Primer worker and frontend (`src/worker/`, `src/frontend/`)
- Authentication and authorization paths (`src/worker/middleware/auth/`, `src/worker/middleware/require-admin.ts`)
- D1 database queries (SQL injection, cross-user data leaks)
- Source-provider integrations (response handling, prompt-injection vectors that exfiltrate Primer data)
- The TTS / LLM dispatcher seams (provider misconfiguration that exposes secrets)
- Any path that allows unauthorized access, privilege escalation, secret exfiltration, or cross-user data leaks

## Out of scope

- Vulnerabilities in third-party dependencies — report upstream; mention here if it's the only practical attack vector against Primer
- Issues requiring physical access to a user's machine
- Self-XSS that requires the victim to paste code into their browser
- Missing security headers without a demonstrated exploit path
- Issues only reproducible with `PRIMER_AUTH_MODE=dev-header` (this mode is intended for local development; production deployments should run in the default `cloudflare-access` mode, which re-verifies every `Cf-Access-Jwt-Assertion` against Cloudflare's JWKS)

## Supported versions

Primer is a single-deployment-per-operator project; the only supported version is the tip of `main`. Security fixes ship to `main` and each operator is responsible for redeploying.

If you operate a long-lived Primer deployment, watch this repo for release notifications so security advisories reach you when they're published.
