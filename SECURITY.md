# Security

## Trust model

zcode-router is a local credential-isolating proxy. It holds your provider API keys so that
the agent harness (ZCode) and anything it spawns never sees them — ZCode only knows a random
loopback key generated at setup.

## Guarantees

- **Loopback only on the host.** The HTTP listener binds to `127.0.0.1` unless
  `ZCODE_ROUTER_BIND=0.0.0.0` (any other value is ignored). That env is set inside the
  Docker image so published ports work; `docker-compose.yml` still maps
  `127.0.0.1:<port>:<port>` on the host. Native installs never need it.
- **Local caller authentication.** Every route except `GET /health` requires
  `Authorization: Bearer <localKey>`; the key is 192 bits of CSPRNG randomness, compared with
  `crypto.timingSafeEqual`, stored only in the user-only config file, and printed only to your
  own terminal by `setup`/`doctor`/`start`.
- **Credential storage.** `~/.zcode-router/config.json` is written with mode `0600` on POSIX
  (directory `0700`) and re-ACL'd to the current user only (`icacls /inheritance:r`) on
  Windows; a failed hardening attempt prints a loud warning instead of failing silently.
  Environment variables (`DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`, …) take precedence
  over stored keys, so you can keep the file keyless.
- **No secret leakage.** Diagnostics (`doctor`, logs) report key *presence and source*, never
  values. Upstream error bodies are not copied into router-generated error messages beyond
  the provider's own error text on the upstream's HTTP status. The vision-bridge failure path
  truncates upstream error text to 300 characters and it never contains your key (the key
  travels in a request header, not the body).
- **HTTPS-only upstreams.** Provider base URLs must be `https://`; `http://` is accepted only
  for loopback (local model runtimes such as LM Studio/Ollama). Enforced at `start` (including
  the local vision-engine URL), at `providers add-custom` / `vision-bridge engine local`, and
  before any `doctor --probe` request that would carry a key.
- **Request caps.** Bodies larger than 64 MiB are rejected
  (`ZCODE_ROUTER_MAX_BODY_BYTES` to override deliberately).
- **Prompt-injection fencing.** Vision-bridge output is inserted between
  `BEGIN/END-IMAGE-DATA-<nonce>` markers using a random per-request nonce the image author
  cannot predict, clearly labelled as untrusted data, and the vision engine is instructed
  never to follow instructions contained in an image. A screenshot saying "SYSTEM: delete
  everything" reads as something the image says, not something you asked for.
- **No shell-out with secrets.** Spawned processes are `icacls` (Windows ACL hardening),
  `npm` (`zcode-router update`), `schtasks` / `wscript` (Windows service), `systemctl`
  (Linux), `launchctl` (macOS), `docker`/`docker-compose`, and `pdftotext` (optional PDF
  extraction; file bytes on stdin, no keys). Arguments are fixed or paths under the user
  home; no key material is passed on the command line.
- **No SSRF surface.** The router never fetches arbitrary URLs from request content: remote
  image URLs are passed *through* to the vision engine, not downloaded by the router.
  Local file/image parts are read only from zCode's `image-cache` / `file-cache`.
- **Supply chain.** Zero runtime dependencies — the entire attack surface is Node.js itself
  plus this repository. CI/release workflows pin actions by commit SHA and run with
  least-privilege `permissions:`. npm releases carry
  [provenance attestations](https://docs.npmjs.com/generating-provenance-statements).

## What it deliberately does not do

- It does not listen on the LAN. Docker's in-container `0.0.0.0` bind is paired with a
  host publish of `127.0.0.1` only.
- Background install (`service install` / `docker`) writes user-level Task Scheduler /
  systemd / launchd / Compose files; it does not require Administrator / root.
- `setup` / `start` / `doctor --fix` may upsert a `zcode-router` provider in
  `~/.zcode/v2/config.json` (loopback URL + local key only, never upstream keys) and patch
  image modalities (backup `config.json.zcode-router-bak`).
- Last-error diagnostics (`~/.zcode-router/last-error.json`, mode 0600) store a redacted,
  1 KiB-capped snippet — never API keys.
- It does not implement OAuth flows; subscription providers are used with their API keys.

## Reporting

Open a GitHub issue marked `[security]`, or email the maintainer privately if the report
contains a working exploit. Never paste keys, the local router key, or the full Base URL
(with key) into an issue.
