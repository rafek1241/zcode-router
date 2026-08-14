# zcode-router — bugs and sharp edges

Things I would fix, ordered by how much they hurt the “install once, forget it” story. Items marked **done in this PR** are already in the branch.

## Fixed here

- **Setup advanced after one number.** Typing `1` + Enter jumped to Docker/service. Setup now toggles `[x]` until empty Enter.
- **ClinePass sent the catalog id upstream.** Cline wants `cline-pass/deepseek-v4-flash`. Models now have an `upstream` field (Command Code, MiniMax, Ollama Cloud Flash, Anthropic too).
- **Default vision engine pinned to `opencode-go/minimax-m3`.** A DeepSeek-only config still claimed that engine. Default is `auto`.
- **Stale vision flags** on opencode-go Kimi K3 / Qwen max (they take images; we treated them as text-only and always spent a bridge call).
- **Doctor was an untestable CLI blob.** Checks live in `src/doctor.js` (`collectDoctorChecks`, `formatDoctorReport`, `applyDoctorFixes`) with `--json` and `--fix`.

## Still wrong or sharp

1. **ZCode provider is still copy-paste.** `setup` prints Base URL + loopback key; it does not write `~/.zcode/v2/config.json` besides the image-modality patch, and that patch only runs if the provider already exists. Plan: `2026-08-14-zcode-auto-register.md`.
2. **Catalog-only providers show an empty picker.** Groq / OpenRouter / Zen / Gemini enable + key, then ZCode’s list is empty until you type an id or `models add`. Plan: `2026-08-14-live-catalog-refresh.md`.
3. **Screenshots still need a vision model.** Setup never asks. DeepSeek-only + default `auto` means the catalog will not advertise images. Plan: `2026-08-14-setup-vision-bridge.md`.
4. **Non-image attachments are not bridged.** PDFs and `file` parts take the same path images used to: ZCode omits them or the upstream 400s. Plan: `2026-08-14-nontext-part-bridge.md`.
5. **Failed upstreams are opaque.** ZCode sees a generic 502/429 with a 300-char snippet; nothing is kept for `doctor`. Plan: `2026-08-14-last-error-doctor.md`.
6. **No timeout on the inference `fetch`.** Streams disable `requestTimeout` (correct) but a hung origin can pin a connection forever. Add an idle timeout or AbortSignal on non-stream calls.
7. **`models vision` / `models remove` only see registry + extras.** A passthrough id you typed in ZCode cannot be flagged `--vision` until `models add`.
8. **Doctor `--probe` is GET `/models`.** Anthropic Messages, some gateways, and keyless loopback will FAIL a probe that is not actually a routing problem. Probe should use the provider protocol (or skip Messages-only providers).
9. **Anthropic `thinking` / `redacted_thinking` blocks are dropped** in `anthropicToOpenai`. Fine for DeepSeek; wrong if someone routes Claude through us and expects thought to round-trip.
10. **Hidden key prompt vs readline.** After the toggle list, `hiddenPrompt` puts stdin in raw mode while the readline interface is still open. Works on a real TTY; worth closing readline around the key prompts if anyone reports swallowed input.
11. **`gpt-5.6-luna` on opencode Go is omitted on purpose** (Responses API). Same for Meta and GitHub Copilot. Users will look for them in the picker and assume a bug.
12. **OAuth Kimi/Grok from Codex Router are not ported.** API-key twins (`kimi-api`, `grok-api`) are. Do not pretend `kimi login` works here.
13. **Qwen plan base URL is Singapore token-plan.** Other regions need `providers add-custom` or a later `baseURL` override in config (the field already exists per provider).
14. **Command Code Go-plan keys authenticate and then 403.** We show the plan note during setup; doctor `--probe` may still look green if `/models` is allowed.
15. **npx + Manual** is still correctly blocked, but the explanation comes *after* provider selection. Harmless, slightly noisy.

## Not bugs

- Passthrough of unknown `provider/model` ids is intentional.
- Advertising image input on text-only models while a vision engine exists is intentional (that is the product).
- Binding `0.0.0.0` inside Docker with `127.0.0.1` publish on the host is intentional.
