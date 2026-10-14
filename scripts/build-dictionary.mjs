#!/usr/bin/env node
// Builds the reader's bundled word-lookup dictionary from wordnet-db's
// WordNet 3.1 data files, plus a frequency-ranked word list used by the
// writer's word completion.
//
// Output (gitignored, regenerated on install and build):
//   public/dict/en.json.gz — { lemma: { d: [[pos, gloss]...], y: [synonyms] } }
//   public/dict/freq.txt   — lemmas sorted by WordNet sense-frequency, one
//                            per line (the prefix-completion candidate list)
//   public/dict/NOTICE.txt — the WordNet license text; Princeton requires it
//                            to travel with the data
//
// WordNet index line:  lemma pos synset_cnt p_cnt ptr... sense_cnt tagsense_cnt offset...
// WordNet data line:   offset lex filenum ss_type w_cnt word lex_id ... p_cnt ptr... | gloss
//
// Runs after `npm install` (postinstall) and on `vite build`
// (copy-dictionary plugin in vite.config.ts). Idempotent: skips the
// expensive parse when the output is already newer than the source.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const POS_FILES = [
  ['noun', 'n'],
  ['verb', 'v'],
  ['adj', 'a'],
  ['adv', 'r'],
];
const POS_NAME = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' };
const MAX_SYNONYMS = 16;
const MAX_SENSES = 8;
const FREQ_LIST_SIZE = 60000;

/** Parse a WordNet data.* file into Map<offset, {words, gloss}>. */
function parseDataFile(text) {
  const byOffset = new Map();
  for (const line of text.split('\n')) {
    if (!line || line[0] === ' ') continue;
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const gloss = line.slice(bar + 1).trim();
    const fields = line.slice(0, bar).trim().split(/\s+/);
    const offset = Number(fields[0]);
    const wordCount = parseInt(fields[3], 10);
    const words = [];
    for (let i = 0; i < wordCount; i++) {
      // Words alternate with lex_id hex digits.
      words.push(fields[4 + i * 2].replace(/_/g, ' '));
    }
    if (!byOffset.has(offset)) byOffset.set(offset, { words, gloss });
  }
  return byOffset;
}

/** Parse a WordNet index.* file into Map<lemma, {offsets, tagsense}>. */
function parseIndexFile(text) {
  const byLemma = new Map();
  for (const line of text.split('\n')) {
    if (!line || line[0] === ' ') continue;
    const fields = line.split(/\s+/);
    const lemma = fields[0];
    const synsetCount = parseInt(fields[2], 10);
    const pointerCount = parseInt(fields[3], 10);
    // sense_cnt then tagsense_cnt sit after the pointer symbols.
    const tagsense = parseInt(fields[4 + pointerCount + 1], 10) || 0;
    const offsets = fields.slice(4 + pointerCount + 2, 4 + pointerCount + 2 + synsetCount).map(Number);
    byLemma.set(lemma.replace(/_/g, ' '), { offsets, tagsense });
  }
  return byLemma;
}

/**
 * Write public/dict/* unless already up to date.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] Defaults to process.cwd().
 * @param {boolean} [options.required] Throw when wordnet-db is missing.
 * @returns {{ wrote: boolean, destDir: string }}
 */
export function syncDictionary(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const required = options.required ?? false;
  const srcDir = resolve(projectRoot, 'node_modules/wordnet-db/dict');
  const destDir = resolve(projectRoot, 'public/dict');
  const dictDest = resolve(destDir, 'en.json.gz');
  const freqDest = resolve(destDir, 'freq.txt');
  const noticeDest = resolve(destDir, 'NOTICE.txt');

  const sources = POS_FILES.map(([name]) => ({
    index: resolve(srcDir, `index.${name}`),
    data: resolve(srcDir, `data.${name}`),
  }));
  if (!sources.every(s => existsSync(s.index) && existsSync(s.data))) {
    if (required) {
      throw new Error(
        `wordnet-db dictionary files not found under ${srcDir}. ` +
        'Run `npm install` or check that wordnet-db is in devDependencies.',
      );
    }
    return { wrote: false, destDir };
  }

  mkdirSync(destDir, { recursive: true });
  const newestSource = Math.max(...sources.flatMap(s => [
    statSync(s.index).mtimeMs, statSync(s.data).mtimeMs,
  ]));
  if (existsSync(dictDest) && existsSync(freqDest)
    && statSync(dictDest).mtimeMs >= newestSource
    && statSync(freqDest).mtimeMs >= newestSource) {
    return { wrote: false, destDir };
  }

  // First pass: every POS file's data + index.
  const entry = new Map(); // lemma -> { d: [[pos, gloss]], y: Set<syn>, tagsense }
  for (const [i, [name, pos]] of POS_FILES.entries()) {
    const data = parseDataFile(readFileSync(sources[i].data, 'utf8'));
    const index = parseIndexFile(readFileSync(sources[i].index, 'utf8'));
    void name;
    for (const [lemma, info] of index) {
      let record = entry.get(lemma);
      if (!record) {
        record = { d: [], y: new Set(), tagsense: 0 };
        entry.set(lemma, record);
      }
      record.tagsense += info.tagsense;
      for (const offset of info.offsets) {
        const synset = data.get(offset);
        if (!synset) continue;
        record.d.push([pos, synset.gloss]);
        for (const word of synset.words) {
          if (word.toLowerCase() !== lemma.toLowerCase() && record.y.size < MAX_SYNONYMS) {
            record.y.add(word);
          }
        }
      }
    }
  }

  // Compose the output object + frequency list.
  const dict = {};
  const ranked = [];
  for (const [lemma, record] of entry) {
    if (!record.d.length) continue;
    const senses = record.d.slice(0, MAX_SENSES);
    const syns = Array.from(record.y);
    dict[lemma] = syns.length ? { d: senses, y: syns } : { d: senses };
    ranked.push([lemma, record.tagsense]);
  }
  ranked.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const freq = ranked.slice(0, FREQ_LIST_SIZE).map(([lemma]) => lemma).join('\n') + '\n';

  const json = JSON.stringify(dict);
  writeFileSync(dictDest, gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
  writeFileSync(freqDest, freq);
  const licenseSrc = resolve(projectRoot, 'node_modules/wordnet-db/LICENSE');
  if (existsSync(licenseSrc)) copyFileSync(licenseSrc, noticeDest);
  console.log(
    `[build-dictionary] wrote ${Object.keys(dict).length} lemmas → ${dictDest} `
    + `(${(statSync(dictDest).size / 1024 / 1024).toFixed(1)} MB gz) + ${freqDest}`,
  );
  return { wrote: true, destDir };
}

// Only run when invoked directly (`node scripts/build-dictionary.mjs`).
const invokedDirectly = process.argv[1]
  && (
    pathToFileURL(process.argv[1]).href === import.meta.url
    || basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])
  );
if (invokedDirectly) {
  syncDictionary({ required: false });
}
