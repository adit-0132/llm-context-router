# In-Browser Conversation Storage — Options Analysis

## Problem

Current flow requires a file download to transfer a conversation between LLMs.
Goal: keep the data in the browser, no file on disk, no server.

---

## User-Proposed Ideas

### Clipboard

**How it would work:** Serialize `.llmchat` JSON → `navigator.clipboard.writeText()` on export.
Import side reads from clipboard on paste or button click.

**Weakest part:** No persistence. One accidental Ctrl+C and the conversation is gone. [Certain]

**Other issues:**
- Clipboard API requires explicit user gesture on some browsers [Certain]
- Large conversations (200KB+) are technically supported but clipboard is not designed for structured data at this size [Likely]
- No cross-device capability without OS-level clipboard sync [Certain]
- UX is awkward: user has to know to paste somewhere specific on the import side

**Verdict:** Useful as a *secondary* fast-path for cross-tab transfer. Bad as primary storage.

---

### Server-Side Database

**How it would work:** Export POSTs conversation JSON to a hosted endpoint.
Import fetches by ID or share link.

**Weakest part:** User's conversation data (potentially confidential) leaves their machine and sits on infrastructure you control — this is a privacy breach by default. [Certain]

**Other issues:**
- Costs money to host and maintain [Certain]
- Requires auth system (who owns which conversation?) [Certain]
- GDPR/data retention obligations [Certain]
- Destroys the "client-side, offline-capable" property the tool currently has [Certain]
- Single point of failure [Certain]

**Verdict:** Overkill and wrong threat model for a local browser tool. Only justified if cross-device sync is a hard requirement.

---

## Better Options

### `chrome.storage.local` (Recommended)

**How it would work:** On export, write the `.llmchat` object to `chrome.storage.local` keyed by conversation ID.
On import (in popup or any tab), read from storage — no file, no server.

**Cost:** Free [Certain]
**Privacy:** Data never leaves the device [Certain]
**Persistence:** Survives browser restarts [Certain]
**Quota:** 5MB default; add `"unlimitedStorage"` to `manifest.json` permissions for no practical limit [Certain]
**Cross-tab:** Any extension context (popup, content script, background) can read/write [Certain]
**Cross-device:** No — tied to one browser profile [Certain]
**Implementation effort:** Low — `chrome.storage.local.set/get` are simple async APIs, already available in the extension

**Weakest part:** Storage is silently cleared if Chrome runs low on disk space or user clears browser data. [Likely]
Data is also not portable if the user switches browsers.

**What needs to change:**
- Popup export button: write to storage instead of (or in addition to) triggering a download
- Popup import UI: add a "from browser storage" option that lists stored conversations
- Add `"unlimitedStorage"` permission to `manifest.json`

---

### `IndexedDB` (Alternative for large conversations)

**How it would work:** Same concept as `chrome.storage.local` but using the browser's IndexedDB API directly from the extension popup context.

**Advantage over `chrome.storage.local`:** No quota limit at all, handles binary data natively [Certain]
**Disadvantage:** More complex API — requires opening a database, versioned schemas, transactions [Certain]

**Verdict:** Justified only if conversations routinely exceed 5MB. `chrome.storage.local` + `unlimitedStorage` is simpler and sufficient. [Likely]

---

### Clipboard as Fast-Path (Secondary)

Keep the clipboard option but scope it correctly: a "Copy to clipboard" button that serializes the JSON.
On the destination tab, a "Paste from clipboard" button reads it.

No persistence guarantee, but zero friction for same-session cross-tab transfers.
Complements `chrome.storage.local`, doesn't replace it.

---

## Recommendation

| Requirement | Solution |
|---|---|
| Primary storage (persistent, private) | `chrome.storage.local` + `unlimitedStorage` |
| Fast cross-tab transfer (same session) | Clipboard as secondary option |
| Cross-device sync | Not supported — would require server (see trade-offs above) |

Implement `chrome.storage.local` first. The manifest change is one line.
The popup needs a stored-conversations list and a way to delete old ones (storage isn't infinite in practice).
