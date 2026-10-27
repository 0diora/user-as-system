# User As System

A tiny SillyTavern / TauriTavern extension for experimenting with **message roles** in
Chat Completion prompts.

It rewrites the role of chat history messages right before the request is sent, without
touching your chat files or the UI:

- **User messages** → `user` (off) / `assistant` / `system`
- **Assistant (AI) messages** → `assistant` (off) / `user` / `system`

Both directions work independently and can be combined (e.g. fully inverting the roles).

## How it works

SillyTavern derives Chat Completion roles as:

```js
role = is_user ? 'user' : 'assistant';
// narrator messages are the sanctioned way to send a system message:
if (message.extra?.type === 'narrator') role = 'system';
```

The extension exposes this as a `generate_interceptor` (runs before prompt assembly) and
also rewrites the final outgoing payload (`CHAT_COMPLETION_PROMPT_READY` /
`GENERATE_AFTER_DATA`), which includes Prompt Manager prompts such as the Main Prompt.

Every conversion happens on shallow clones — the live chat, chat history files and the UI
are never modified. Conversions apply only to the generated request.

`quiet` and `impersonate` generation types, dry runs (token counting), tool rows and
hidden/system notes are left untouched.

## Install

In SillyTavern / TauriTavern:

1. Open **Extensions** → **Install Extension**
2. Paste this repository URL:
   `https://github.com/0diora/user-as-system`
3. Reload if asked.

Or clone manually into your extensions folder:

```bash
cd <data-root>/default-user/extensions
git clone https://github.com/0diora/user-as-system
```

## Settings

The extension adds a drawer to the Extensions panel:

| Setting | Description |
| --- | --- |
| **Enabled** | Master switch |
| **Convert user messages to** | `user` (no conversion) / `assistant` / `system` |
| **Convert assistant (AI) messages to** | `assistant` (no conversion) / `user` / `system` |
| **Keep the newest user message unchanged** | Applies to the user-message conversion only |

Settings are saved per user.

## Verify

The token breakdown view in the Prompt Manager can show pre-conversion roles. The
authoritative source is the outgoing request:

- TauriTavern: `logs/llm-api-*.request.json` (with dev LLM logging enabled)
- or the LLM API log viewer in the app

## Notes

- Exists mainly as an experiment; expect model behavior to change when roles are not
  `user`/`assistant` as the provider expects.
- Some providers (especially strict ones) may reject prompts with no `user` turn. Use
  **Keep the newest user message unchanged** if needed.

## License

MIT
