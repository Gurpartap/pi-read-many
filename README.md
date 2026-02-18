# 📚 pi-read-many

[![pi coding agent](https://img.shields.io/badge/pi-coding%20agent-6f6bff?logo=terminal&logoColor=white)](https://pi.dev/)
[![npm version](https://img.shields.io/npm/v/pi-read-many.svg)](https://www.npmjs.com/package/pi-read-many)
[![license](https://img.shields.io/npm/l/pi-read-many.svg)](LICENSE)

Batch file reads for Pi via a single tool: **`read_many`**.

It helps the model inspect multiple files in one call instead of issuing many separate `read` calls.

---

## 🚀 Install

### Preferred (npm)

```bash
pi install npm:pi-read-many
```

### Alternative (source)

```bash
pi install git:https://github.com/Gurpartap/pi-read-many
```

After install, use Pi normally. If Pi is already running when you install or update, run:

```text
/reload
```

---

## 📝 Notes

- `read_many` does **not** override built-in `read`.
- `read_many` summarizes image attachments in combined text output; exact single-file image payload behavior remains in built-in `read`.

---

## ✨ What `read_many` does

- Reads files **sequentially in request order**.
- Uses Pi's built-in `read` under the hood (same core semantics).
- Returns one combined text response using per-file heredoc blocks.
- Continues on per-file errors by default (`stopOnError: false`).
- Applies combined output budgeting with block-safe packing.
- Exposes packing decisions in `details.packing`.

### Additional behavior

- **Adaptive packing:** starts with strict request-order full-block packing.
- **Strategy switch:** uses smallest-first **only if** it increases complete successful-file coverage.
- **Stable output order:** rendered sections still follow original request order.
- **Partial inclusion:** includes at most one partial section when needed.
- **Error consistency:** errors are framed exactly like normal file blocks.
- **Image-safe output:** image payloads are summarized in text.

## 🔢 Example `read_many` input

```json
{
  "files": [
    { "path": "src/a.ts" },
    { "path": "src/b.ts", "offset": 40, "limit": 120 }
  ],
  "stopOnError": false
}
```

---

## 📦 Output format

Each included file is returned in this framed block format:

```bash
@path/to/file
<<'WORD_INDEX_HASH'
...file content...
WORD_INDEX_HASH
```

### Delimiter rules (`DICT_N_HASH`)

- `WORD`: fixed readable dictionary word
- `INDEX`: 1-based file index in request
- `HASH`: deterministic short hash of file path

`read_many` allows **up to 26 files**, with a **26-word dictionary** (unique starting letter per word), so each file gets a unique dictionary token.

If a delimiter collides with a content line, the tool auto-suffixes (`_1`, `_2`, …) and keeps trying deterministic fallbacks until it finds a safe delimiter.

---

## 🧾 `details.packing` fields

| Field | Meaning |
|---|---|
| `strategy` | Chosen packing strategy (`request-order` or `smallest-first`) |
| `switchedForCoverage` | Whether strategy switched to improve successful full-file coverage |
| `fullIncludedCount` | Number of fully included blocks |
| `fullIncludedSuccessCount` | Number of fully included successful blocks |
| `partialIncludedPath` | Path of partially included block (if any) |
| `omittedPaths` | Paths omitted due to budget limits |

---

## 🛠️ Development

```bash
npm install
npm run typecheck
npm test
```

Tests are unit-level and do not launch Pi directly.

For local one-off development loading:

```bash
pi -e ./read-many.ts
```

---

## 📄 License

MIT © 2026 Gurpartap Singh
