---
name: sanitize-guard
description: "Workaround: avoid specific trigger-phrases that can cause a false error-banner rewrite in older releases."
metadata: { "openclaw": { "emoji": "🛡️", "events": ["agent:bootstrap"] } }
---

# sanitize-guard

Injects a small addendum into the agent's injected SOUL content so the model avoids known trigger-phrases.
