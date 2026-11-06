# Reading capabilities — coverage matrix

What a mature assistive reading suite offers, and where Yapper stands.
Domains are ordered by how much they matter to the core job: getting
written text into a reader's ears without losing their place.

Status: **have** · **partial** · **missing** · **not offered** (deliberate,
with the reason in the notes).

Every row was checked against the source tree, not against the previous
version of this table. Module paths are given where the implementation is
worth reading; user-facing names are the ones the app uses.

## 1. Reading and speech

| Capability | Status | Notes |
|---|---|---|
| Read / pause / resume from position | have | `reader.ts` session + stream player; playback can start from a click in the text |
| Reading position remembered per file | have | `persistence.ts`; the recent-documents shelf shows how far the file was read before it is opened again |
| Word-level highlighting synced to audio | have | Real engine timings where the engine reports them, estimated fallback otherwise |
| **Dual highlighting** — current word *and* current unit, two colours | have | Unit band plus word, with a legend in the reader overlay; a dense page needs both answers at once |
| **Reading unit** — word / line / sentence / paragraph | have | `reading-units.ts`; selector in the reader bar, changes both the highlight and how far skip moves |
| **Reading mode** — continuous / self-paced / word-by-word | partial | Continuous (and silent) only. The unit selector changes granularity, not the speech mode |
| **Silent reading** — highlight without audio | have | Highlight advances on a clock derived from the text; needs no model and no audio |
| Speed control | have | 0.5–2.0× for model voices; Quick read has its own 0.75–1.5× cycle |
| Skip current unit forward/back | have | Buttons in the reader bar and overlay, plus `[` / `]` |
| Syllabification | have | `dictionary.syllabify`; shown in word lookup and in the vocabulary study guide (not a reader command) |
| **Say-as overrides** (pronunciation editor) | have | `pronunciation.ts`; `word = say` rules persisted locally and applied to speech only — the page keeps the author's spelling |
| Per-section voices | have | A paragraph or a selection can be given a different voice; chunks are split so no chunk spans two voices |
| Pause at bookmark | missing | A bookmark can be visited, but reading does not stop there |
| Stop at end of page | missing | Continuous reading runs past the page break |

## 2. Ingestion

| Capability | Status | Notes |
|---|---|---|
| PDF / DOCX / DOC / ODT / RTF / EPUB / XLSX / PPTX / CSV / HTML / TXT / MD | have | `document-reader.ts`; PDF capped at 500 pages, upload capped at 25 MB |
| OCR for scanned pages | have | Tesseract (fast, small WASM core) or Florence-2 (slower, larger download), chosen per document |
| Web page reading | partial | Paste a URL and read it as a document (`web-document.ts`). Cross-origin pages that refuse to be read surface an honest CORS error; no browser extension |
| **Select-to-read** — drag a box over a page, hear it | have | Drag over a rendered page, crop, OCR with Tesseract, speak through Quick read. Works inside the document view, not over other applications |
| Camera / phone photo of a page | missing | Needs an image-capture path before OCR |
| **Reading regions** — rectangles with a kind: main text / side text / skip / figure | missing | Not built. The fix for multi-column and sidebar-heavy scans |
| Per-page correction of the recognised text | missing | There is no editable page surface; OCR is re-run or corrected by rule (next two rows) |
| **Corrections list** — find/replace for recurring OCR errors | have | `corrections.ts`; whole-word or `*infix` rules, applied at extraction time, importable/exportable as `.txt` |
| Header/footer suppression | have | `header-footer.ts`; drops repeating page margins on PDF import, on by default |
| Page range on open | missing | Large books are read whole |
| Two-page / facing-page capture | missing | |

## 3. Writing support

| Capability | Status | Notes |
|---|---|---|
| Spell check with suggestions | have | `spellcheck.ts`; bundled dictionary plus a frequency-ranked suggestion list |
| Word prediction / completion | have | Frequency-ranked completions for the word under the caret; Tab accepts the first. No learning from the user's own writing |
| Dictionary | have | `dictionary.ts` with senses and synonyms, from a bundled WordNet extract |
| Syllabification in the study guide | have | |
| **Speak as you type** — word by word | have | Speaks each finished word; **Read text** speaks the whole draft |
| **Dictation** (speech to text) | have | Studio: on-device Whisper Tiny (41 MB, WASM), push-to-talk. Write page: the browser's own recogniser, which on some browsers uses the vendor's service |
| Homophones and confusables | missing | |
| **Review checklist** — editable proofing checklist, state kept | missing | |
| Bibliography (MLA / APA) | missing | |
| Brainstorm → outline → draft as linked views | missing | The reader has a document outline, but there is no writing workflow around it |

## 4. Study tools

| Capability | Status | Notes |
|---|---|---|
| Colour highlights with notes | have | Yellow / green / blue, stored per file |
| Bookmarks | have | Named, optional note, per file |
| Three-column notes | have | Editable margin rail: the document line a note hangs off (the cue) and the reader's note, stored per file |
| **Extract notes and highlights** into a new document, with outline numbering | partial | Notes export as Markdown (bookmarks and highlighted quotes). No numbering styles |
| Extract highlights into three-column notes by colour | missing | |
| **Cover the notes or cues column** for self-testing | have | `column-cover.ts`; cover either field, reveal each card individually or all at once |
| Voice notes (record audio) | have | Record, play, delete; 2-minute cap; stored per document in IndexedDB |
| Prompt notes (inline question/answer) | have | Question pinned to a word or paragraph; a marker in the text opens the stored answer, and the list lives in the study tools panel |
| Brainstorm / mind map | missing | |
| Vocabulary study guide | have | `vocabulary.ts`; uncommon words ranked from the document, saved word list exported as Markdown with syllables, senses and the source sentence |
| Build the study guide from highlights | missing | The guide is built from the saved word list, not from highlights |
| Test answers and a numbered test sheet | have | `testsheet.ts`; answer at a question spot, export a numbered Markdown sheet with the question context |
| Spoken review of notes | have | `document-review.ts`; reads highlights and bookmarks in document order, painting each as it speaks |
| Reading statistics | have | `document-stats.ts`; position, word count and estimated reading time in the status bar |

## 5. Document restrictions

Status corrected: the earlier plan listed "test timer" and "answer
masking" as targets. Neither is implemented, and neither is a documented
requirement of this app, so they are not counted as gaps — they would be
additions.

| Capability | Status | Notes |
|---|---|---|
| **Document restrictions** — restrict what a document allows, password-gated | have | Five actions (edit recognised text, copy text out, export audio, change voice, open another document). Reading aloud is never restricted. Password kept as a salted PBKDF2-SHA-256 digest |
| Broadcast / template restrictions for a whole class | missing | Out of scope for a local app |

A restriction is a guard against casual circumvention, not a security
boundary: the reader controls the browser and can remove the record. It is
keyed to the file's identity, so a renamed copy is a different document and
is not restricted.

## 6. Export

| Capability | Status | Notes |
|---|---|---|
| Document as Markdown / HTML / Text | have | `document-export.ts` |
| Notes export (bookmarks + highlighted quotes) | have | Markdown, per document |
| WAV of a single clip | have | |
| Download every finished clip as one WAV | have | From the queue |
| Audiobook bundle | have | `audiobook.ts`; merged WAV, document WebVTT, a chapter track when the document has sections, and a self-contained karaoke page in one zip |
| WebVTT captions | have | Inside the audiobook bundle |
| **DAISY 3 talking book** (audio + SMIL + navigation) | partial | `daisy.ts` builds a complete Z39.86-2005 book (OPF, NCX, DTBook, one SMIL and one WAV per chapter) and is covered by tests, but the export menu does not call it yet |
| **MP3** | not offered | Deliberately absent: every maintained in-browser MP3 encoder available to this project is a copyleft LAME or Shine port. WAV is the format the app can encode without a copyleft dependency |
| Email / cloud destinations | not offered | Conflicts with local-only by design |

## 7. Accessibility and interface

| Capability | Status | Notes |
|---|---|---|
| Dark mode, keyboard navigation, ARIA live regions | have | App theme is light / dark / system; skip link, visible focus, live regions on every async status |
| Reading themes, font family, type size | have | Light / sepia / night, serif / sans / mono, and a type-size control for reflowable documents; PDF pages zoom in 15% steps |
| Letter / word / line spacing control | missing | |
| **Configurable hotkeys** | partial | Single-key shortcuts can be switched off (WCAG 2.1.4), but keys are not remappable |
| Magnification | have | Document zoom and type size; browser zoom covers the rest of the interface |
| Reduced motion | have | `prefers-reduced-motion` is honoured |
| Reading ruler / focus guide | not offered | An addition rather than something this app has ever offered |

## Sequencing

Working order, by (readers helped) ÷ (effort).

### Done

- Say-as overrides / pronunciation editor
- On-device dictation (Whisper Tiny, 41 MB, WASM)
- Silent reading, skip unit forward/back, reading-unit selector
- Dual highlighting
- Select-to-read
- OCR corrections list and header/footer suppression
- Document restrictions, password-gated
- Voice notes, prompt notes, and the three-column-note self-test
- Per-section voices
- Document export, audiobook bundle, spoken notes review
- Vocabulary study guide and test sheets

### Remaining

| # | Work | Effort |
|---|---|---|
| 1 | Wire the DAISY 3 book builder into the export menu | small |
| 2 | Stop at end of page, and pause at a bookmark | small |
| 3 | Extract highlights into three-column notes by colour | small |
| 4 | Extract highlights into a vocabulary study guide | small |
| 5 | Page range on open | small |
| 6 | Letter / word / line spacing controls | small |
| 7 | Self-paced reading mode | moderate |
| 8 | Per-page correction of the recognised text | moderate |
| 9 | Configurable hotkeys | moderate |
| 10 | Homophones and confusables | moderate |
| 11 | Editable review checklist | moderate |
| 12 | Bibliography (MLA / APA) | moderate |
| 13 | Brainstorm → outline → draft as linked views | large |
| 14 | Reading regions — reorder, skip, or silence recognised blocks | large |

### Open decisions, not tasks

- **MP3 is not offered, and that is final for this codebase.** It was
  investigated: every maintained in-browser encoder available is a port of
  LAME or Shine under the LGPL, and the project takes no copyleft dependency.
  WAV is what the app can encode legally without one. A permissively licensed
  encoder would be the only reason to revisit it; the encoder boundary is
  isolated in `daisy.ts` and `audio-export.ts` for that day.
- **Dictation accuracy on spelled-out punctuation.** Whisper Tiny merges
  "jordan dot lee at example dot com" into `jordan.lea.example.com`. A larger
  checkpoint fixes it at roughly 3× the download. Cost, not code.
- **Voice-activity detection.** The envelope gate is a heuristic. Silero VAD
  (~2 MB) is the correct upgrade; not worth it until the heuristic
  misbehaves on real microphones.
- **Translation / bilingual reading** needs an on-device MT model, which is a
  much larger dependency than anything here. Out of scope until decided.
