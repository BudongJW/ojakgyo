# Security Policy

ojakgyo handles OAuth tokens for your streaming account and runs a local web server, so we take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/BudongJW/ojakgyo/security/advisories/new) instead, with:

- what an attacker could do,
- steps to reproduce,
- the ojakgyo version and your OS.

You will get an acknowledgement within a few days and a fix or mitigation plan as soon as the issue is confirmed.

## Design notes

- The server binds to `127.0.0.1` by default and rejects cross-origin HTTP and WebSocket requests.
- OAuth tokens and the VTube Studio plugin token are stored in `.ojakgyo/secrets.json` with owner-only permissions.
- Viewer-supplied text is always rendered with `textContent`, never as HTML.
- Session URLs (which carry auth tokens) are never written to logs.

If you expose ojakgyo beyond localhost (for example `server.host: 0.0.0.0`), anyone on that network can reach the dashboard. Don't, unless you put it behind your own authentication.
