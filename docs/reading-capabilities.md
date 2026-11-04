# Reading capabilities — coverage matrix

What a mature assistive reading suite offers, and where Yapper stands.
Domains are ordered by how much they matter to the core job: getting
written text into a reader's ears without losing their place.

Status: **have** · **partial** · **missing**

## 1. Reading and speech

| Capability | Status | Notes |
|---|---|---|
| Read / pause / resume from position | have | `reader.ts` session + stream player |
| Word-level highlighting synced to audio | have | real engine timings, estimated fallback |
| **Dual highlighting** — current word *and* current unit, two colours | missing | readers keep their place from the sentence band, not just the word |
| **Reading unit** — word / line / sentence / paragraph | missing | changes what is highlighted and how far skip jumps |
| **Reading mode** — continuous / self-paced / word-by-word | partial | continuous only; self-paced is the standard study mode |
| **Silent reading** — highlight without audio | missing | one toggle; turns the reader into a following tool |
| Speed control | have | 0.5–2.0x |
| Skip current unit forward/back | missing | small, high-frequency |
| Syllabification | partial | `dictionary.syllabify` exists, not exposed as a reader command |
| **Say-as overrides** (pronunciation editor) | have | `pronunciation.ts`, committed |
| Per-section voice / language tagging | missing | multilingual documents currently get one voice |
| Pause at bookmark | missing | cues "your answer starts here" |
| Stop at end of page | missing | continuous mode runs past the page break |

## 2. Ingestion

| Capability | Status | Notes |
|---|---|---|
| PDF / DOCX / DOC / ODT / RTF / EPUB / XLSX / PPTX / CSV / HTML / TXT / MD | have | `document-reader.ts` |
| OCR for scanned pages | have | Tesseract + Florence-2 |
| Web page reading | partial | `web-document.ts`; no browser extension |
| **Region OCR** — drag a box over any text on screen, hear it | missing | the single highest-leverage capture feature |
| Camera / phone photo of a page | missing | `input capture` + OCR |
| **Zone editor** — reorder or silence recognised blocks | missing | the fix for multi-column and sidebar-heavy scans |
| Correct the recognised text under the page | partial | text view is editable; no image-anchored correction |
| **Corrections list** — find/replace for recurring OCR errors | missing | fix "rn" → "m" once, forever |
| Header/footer suppression | missing | running heads get read aloud today |
| Page range on open | missing | large books |
| Two-page / facing-page capture | missing | |

## 3. Writing support

| Capability | Status | Notes |
|---|---|---|
| Spell check with suggestions | have | `spellcheck.ts`, edit distance |
| Word prediction / completion | have | `predictCompletions`; no frequency learning |
| Dictionary | have | `dictionary.ts` with senses |
| Syllabification in the study guide | have | |
| **Speak as you type** — char / word / sentence | missing | |
| **Dictation** (speech to text) | missing | needs a local ASR model |
| Homophones & confusables lists | missing | |
| **Review checklist** — editable proofing checklist, state kept | missing | |
| Bibliography (MLA / APA) | missing | |
| Brainstorm → outline → draft as linked views | missing | |

## 4. Study tools

| Capability | Status | Notes |
|---|---|---|
| Colour highlights with notes | have | |
| Bookmarks | have | |
| Column notes | partial | stored, not a first-class editable surface |
| **Extract notes and highlights** into a new document, with outline numbering | partial | notes export exists; no numbering styles |
| Extract highlights into column notes by colour | missing | |
| Extract highlights into a vocabulary study guide | partial | `vocabulary.ts` builds one from candidates, not from highlights |
| **Cover a column / hide a column** for self-testing | missing | cheap and very effective |
| Voice notes (record audio) | missing | |
| Bubble notes (inline question/answer) | missing | |
| Brainstorm / mind map | missing | |
| Vocabulary study guide | have | `vocabulary.ts` |

## 5. Locking and assessment

Status corrected: the earlier plan claimed "test timer" and "answer
masking" as targets. Public documentation does not describe either, so
they are not counted as gaps — they would be additions, not parity.

| Capability | Status | Notes |
|---|---|---|
| **Feature locks** — restrict what a document allows, password-gated | missing | real and documented; locks are per-document, teacher-set |
| Broadcast / template locks for a whole class | missing | out of scope for a local app |

## 6. Export

| Capability | Status | Notes |
|---|---|---|
| WAV of a single clip | have | |
| Audiobook bundle | have | `audiobook.ts` |
| WebVTT captions | have | |
| **MP3** | missing | WAV is 10x the size for the same audio |
| **DAISY 3 talking book** (audio + SMIL + navigation) | missing | the standard format for accessible books |
| Email / cloud destinations | out of scope | conflicts with local-only by design |

## 7. Accessibility and interface

| Capability | Status | Notes |
|---|---|---|
| Dark mode, keyboard navigation, ARIA live regions | have | |
| Font / spacing / theme control | partial | theme + font family; no spacing |
| **Configurable hotkeys** | missing | |
| Magnification | out of scope | browser zoom covers it |
| Reading ruler / focus guide | **not a gap** | no public documentation; would be an addition |

## Sequencing

Working order, by (readers helped) ÷ (effort):

1. Silent reading toggle + skip unit forward/back — hours, used every session
2. Reading unit selector (word / line / sentence / paragraph) + self-paced mode
3. MP3 export
4. Dual highlighting
5. Corrections list (OCR find/replace)
6. Header/footer suppression
7. Region OCR
8. Feature locks
9. DAISY 3 export
10. Zone editor
11. Per-section voice tagging
12. Voice notes, bubble notes, column-note covering
13. Dictation (needs a local ASR model — a dependency decision, not a coding one)
