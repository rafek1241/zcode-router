# Non-text part bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ZCode attaches a PDF or other non-image file that the upstream model cannot accept, the router turns it into labelled text the same way the vision bridge handles screenshots — so the local layer stays the place extra modalities are filled in.

**Architecture:** Extend `src/vision.js` (already extracts data URLs, Anthropic image blocks, and zCode image-cache paths) with a sibling `bridgeFiles` that: (1) finds `file` / `document` / `file_url` parts, (2) reads only zCode cache paths plus `data:` URLs, (3) extracts text (PDF via a tiny existing approach — see ceiling below), (4) replaces the part with a fenced evidence block, (5) caches by hash for 1 hour.

**Tech Stack:** Node 22, current vision cache, no new PDF library until a one-pager of real PDFs proves `pdftotext`/`python` isn't on PATH. Ceiling: shell out to `pdftotext` if present; otherwise insert an ILLEGIBLE note rather than inventing bytes.

## Global Constraints

- Same trust boundary as images: refuse paths outside `~/.zcode/**/image-cache` and any future `~/.zcode/**/file-cache`.
- 20 MiB cap, matching `MAX_LOCAL_IMAGE_BYTES`.
- Fail by telling the model the file could not be read — never drop the turn.
- Do not run arbitrary converters on remote URLs.

---

### Task 1: Detect file parts and rewrite to text

**Files:**
- Modify: `src/vision.js`
- Test: `test/vision-extract.test.js`

**Interfaces:**
- Consumes: OpenAI/Anthropic message bodies
- Produces: mutated `messages` with file parts replaced by ` ```file ... ``` ` fences

- [ ] **Step 1: Write the failing test**

```js
test('file_url parts inside zCode cache become fenced text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-file-'));
  const file = path.join(dir, '.zcode', 'cli', 'image-cache', 'sess', 'note.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'hello from a paste');
  const body = {
    messages: [{
      role: 'user',
      content: [{ type: 'file_url', file_url: { url: file } }],
    }],
  };
  await bridgeFiles(body, { log() {} });
  const text = body.messages[0].content.map((p) => p.text || '').join('');
  assert.match(text, /hello from a paste/);
  assert.doesNotMatch(JSON.stringify(body), /file_url/);
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `isFilePart`, `bridgeFiles`, call it from `handleChat` next to `bridgeImages` when the route is not marked for that modality**
- [ ] **Step 4: Tests pass**
- [ ] **Step 5: Commit**

```bash
git add src/vision.js src/server.js test/vision-extract.test.js
git commit -m "feat: bridge non-image file parts to text for text-only models"
```

### Task 2: PDF bytes

**Files:**
- Modify: `src/vision.js`

- [ ] **Step 1:** If the file is `%PDF` and `pdftotext` exists, spawn it with a timeout and capture stdout.
- [ ] **Step 2:** If not, substitute `ILLEGIBLE: PDF (no local extractor)`. Do not add a PDF npm dependency in this task.
- [ ] **Step 3:** Cache by sha256 of the bytes, same `VisionCache` class.
- [ ] **Step 4: Commit**

```bash
git add src/vision.js test/vision-extract.test.js
git commit -m "feat: extract PDF text via pdftotext when present"
```
