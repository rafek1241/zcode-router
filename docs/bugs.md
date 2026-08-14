# zcode-router — bugs and sharp edges

Things I would fix, ordered by how much they hurt the “install once, forget it” story.

## Fixed here

- **Setup advanced after one number.** Typing `1` + Enter jumped to Docker/service. Setup now toggles `[x]` until empty Enter.
- **ClinePass sent the catalog id upstream.** Cline wants `cline-pass/deepseek-v4-flash`. Models now have an `upstream` field (Command Code, MiniMax, Ollama Cloud Flash, Anthropic too).
- **Default vision engine pinned to `opencode-go/minimax-m3`.** A DeepSeek-only config still claimed that engine. Default is `auto`.
- **Stale vision flags** on opencode-go Kimi K3 / Qwen max (they take images; we treated them as text-only and always spent a bridge call).
- **Doctor was an untestable CLI blob.** Checks live in `src/doctor.js` (`collectDoctorChecks`, `formatDoctorReport`, `applyDoctorFixes`) with `--json` and `--fix`.
- **ZCode provider was copy-paste.** `setup` / `start` / `zcode-patch` / `doctor --fix` upsert a `zcode-router` provider into `~/.zcode/v2/config.json`.
- **Catalog-only providers showed an empty picker.** `models refresh` GETs `/models` and stores new ids as extras.
- **Setup never asked about screenshots.** After keys, setup offers `auto` / pin / `local` / `off`.
- **Non-image attachments were not bridged.** `file` / `document` / `file_url` parts in zCode caches (and `data:` URLs) become fenced text. PDFs use `pdftotext` when present.
- **Failed upstreams were opaque.** Last error is stored at `~/.zcode-router/last-error.json`; `doctor` and `doctor last` print it.
- **No timeout on non-stream `fetch`.** Non-stream upstream calls abort after `ZCODE_ROUTER_UPSTREAM_TIMEOUT_MS` (default 120s). Streams stay unlimited.
- **`models vision` required a registry/extra row.** Passthrough ids now take a vision override directly.
- **Doctor `--probe` always used Bearer `GET /models`.** Messages-protocol providers send `x-api-key`; loopback is skipped. Command Code still notes that `/models` 200 ≠ chat.
- **Anthropic `thinking` / `redacted_thinking` dropped** in the OpenAI translation. They round-trip now.
- **Hidden key prompt vs open readline.** Setup closes readline around `hiddenPrompt`, then recreates it for vision + deployment.
- **Qwen plan URL was Singapore-only.** Set `QWEN_PLAN_BASE_URL` (or a per-provider `baseURL`) for another region.
- **npx + Manual warning came after provider pick.** It now prints at the start of setup too.
- **`zai-coding` duplicated ZCode's built-in GLM Coding Plan.** Removed from the registry.

## Still omitted on purpose

- **`gpt-5.6-luna` on opencode Go, Meta, GitHub Copilot** — Responses API. This router speaks Chat Completions and Anthropic Messages.
- **OAuth Kimi/Grok from Codex Router** — API-key twins (`kimi-api`, `grok-api`) are in the registry. `kimi login` is not.

## Not bugs

- Passthrough of unknown `provider/model` ids is intentional.
- Advertising image input on text-only models while a vision engine exists is intentional (that is the product).
- Binding `0.0.0.0` inside Docker with `127.0.0.1` publish on the host is intentional.
