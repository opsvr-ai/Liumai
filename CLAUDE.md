## AXME Code

### Session Start (MANDATORY)
Call axme_context at the start of every session.
If it returns "not initialized": offer the user AXME setup, and on consent
EXECUTE the inline setup flow from axme_context / the server instructions
(a sequence of axme_save_decision / axme_save_memory / axme_update_safety /
axme_save_oracle tool calls). Do NOT try to run `axme-code` via the Bash
tool — on plugin installs it is not on PATH.
Do NOT skip — without context you will miss critical project rules.
