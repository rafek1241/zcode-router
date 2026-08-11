# Security

## Trust model

zcode-router is a local credential-isolating proxy. It holds your provider API keys so that
the agent harness (ZCode) and anything it spawns never sees them — ZCode only knows a random
loopback key generated at setup.

## Guarantees

- **Loopback only.** The HTTP listener binds to `127.0.0.1`. There is no option to bind
  otherwise.
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
- **No shell-out with secrets.** The only spawned processes are `icacls` (Windows ACL
  hardening, fixed arguments) and `npm` (`zcode-router update`, fixed arguments). No
  user-controlled input reaches either.
- **No SSRF surface.** The router never fetches arbitrary URLs from request content: remote
  image URLs are passed *through* to the vision engine, not downloaded by the router.
- **Supply chain.** Zero runtime dependencies — the entire attack surface is Node.js itself
  plus this repository. CI/release workflows pin actions by commit SHA and run with
  least-privilege `permissions:`. npm releases carry
  [provenance attestations](https://docs.npmjs.com/generating-provenance-statements).

## What it deliberately does not do

- It does not run as a background service or modify the OS — it is one foreground process.
- It does not modify ZCode's files or settings; integration is a standard custom provider
  entry you can delete at any time.
- It does not implement OAuth flows; subscription providers are used with their API keys.

## Reporting

Open a GitHub issue marked `[security]`, or email the maintainer privately if the report
contains a working exploit. Never paste keys, the local router key, or the full Base URL
(with key) into an issue.
