# Platform testing log

Living handoff document for cross-platform verification of yapper on macOS (Safari)
and Windows (Edge/Chrome). Any agent picking this up: read this file first, do the
next unchecked item, update the file, commit, and push to `devin/platform-testing`.

## Context

- Base: `main` @ `1b7bf84` (squash-merge of PR #77 — iOS Safari support + reader-first
  pivot + feature-gap work + WCAG 2.1 AA remediation).
- WCAG audit already done on Linux Chromium: axe (wcag2a/2aa/21a/21aa/best-practice)
  = 0 violations on all surfaces, plus manual keyboard/focus/name checks.
- Running child sessions:
  - macOS / Safari: `devin-a52d0787d8904290badef8c19a3c945b`
  - Windows / Edge: `devin-ba728ebcf8164389baabf5003a795362`

## Setup recipe (per platform)

1. `git clone https://github.com/phantomic12/yapper && cd yapper && git checkout devin/platform-testing`
2. `npm install` (Node 20+)
3. `npm run build`
4. Serve `dist/`: `npx http-server dist -p 5199 -s` (or `python3 -m http.server 5199 -d dist`)
5. Open `http://localhost:5199/?fresh=1` in the platform-native browser.
   - GOTCHA: cache-first service worker — after any rebuild, clear site data or use a
     fresh profile/incognito and a `?fresh=` query so you get the new shell.

## Test checklist (same on both platforms)

- [ ] Page loads, zero console errors (record browser name + version)
- [ ] Pick a small model (Kitten Nano / SpeechT5), download + load — note WebGPU vs WASM path
- [ ] Generate speech from default text — WAV plays audibly
- [ ] Open sample document → full-window reader appears
- [ ] "Quick read" (speechSynthesis) plays audio
- [ ] "Look up" mode on a word shows dictionary popover
- [ ] Write tab: prediction/spell-check visible; speak-while-typing if possible
- [ ] Keyboard: tab order sane, focus ring visible, `?` opens shortcut sheet
- [ ] Reader "Read aloud" (model TTS over a document) — at least first sentence plays

## Results

| Platform | Browser | Load path | TTS | Reader | Quick read | Lookup | Write | Keyboard | Verdict |
|----------|---------|-----------|-----|--------|------------|--------|-------|----------|---------|
| macOS    | —       | —         | —   | —      | —          | —      | —     | —        | pending |
| Windows  | —       | —         | —   | —      | —          | —      | —     | —        | pending |

## Findings log

Append below: `YYYY-MM-DD <platform> — <what happened>`

- 2026-10-14 linux — log created; both child sessions dispatched.
