# Security and privacy

This public repository intentionally contains **no live credentials, private Sheet ID, real applicant profile, production webhook URL or personal job-search history**. It is a sanitized copy with user-supplied configuration required.

## Before use

1. **Google Apps Script:** deploy with **Execute as me / Only myself**. Store all confidential IDs/keys in Script Properties; never in `Index.html`, GitHub Actions logs or public README.
2. **n8n:** leave imported workflows inactive until every credential and destination has been reviewed. Restrict form/webhook access using your instance's authentication controls. Avoid running arbitrary URLs in any public unauthenticated workflow.
3. **Worker:** do not expose its Docker TCP port publicly; use a private Docker network, Tailscale or equivalent. Protect all calls with `X-Worker-Token`. Keep `WORKER_TOKEN`, `rclone.conf`, profile documents and API keys out of Git.
4. **Untrusted URLs:** job links may target internal networks, redirect to private addresses, or change DNS between validation and connection. The worker's URL preflight check is not a full substitute for network egress restrictions. Do not run it with access to sensitive internal networks.
5. **LLM outputs:** job descriptions are untrusted external text, including prompt-injection attempts. Never treat extracted text as configuration instructions or credentials.
6. **Personal data:** documents, user notes, jobs and applications can contain identifiable and sensitive information. Use real data only in a private account with carefully scoped sharing permissions and provider data policies.
7. **Source platform permissions:** respect website access policies, robots directives where applicable, API limits and privacy/terms. Some sites cannot be scanned safely or reliably.
8. **Publication:** check both current file contents **and Git history** before publishing changes, particularly if copied from a private repository.

## Known limitations

- The Apps Script lock-and-hash pattern reduces accidental overwrites but does not supply ACID database guarantees.
- The default scanner includes provider-specific parsing logic and may break when APIs or sites change.
- A running worker can make outgoing HTTP requests and handle private documents; isolate it carefully.
- The public GitHub Pages demo uses only synthetic data and is intentionally disconnected from the private app.
- The repository excludes OAuth token exports, production `.clasp.json`, actual n8n credential bindings and live provider identifiers.
