/**
 * Making the voice picker something you can actually choose from.
 *
 * Kokoro ships 28 named voices, and until now choosing one meant reading 28
 * lines of text in a flat grid and guessing. "Sarah" and "Nova" tell you
 * nothing about how they sound. Two things fix that, and they are the whole
 * point of this module:
 *
 *   1. An audition. Press a button, hear that one voice say one sentence
 *      ("Hear it"), and the name stops being a label and becomes a memory.
 *   2. Grouping. 28 cards with no structure is a wall. Sorted by accent and
 *      gender, the same 28 become four rows a human can scan — "I want the
 *      British one", "male or female?" — which is the question people are
 *      actually answering when they pick a voice.
 *
 * Note what is deliberately NOT here: cloning, voice conversion, or any way
 * to synthesise from a recording. The ask was natural human voices you pick
 * from a list, so the picker stays a picker. See docs/tts-model-landscape.md
 * for why that rules out Chatterbox-style zero-shot cloning as a feature.
 *
 * Synthesis is deliberately routed through TTSEngine.preview() rather than
 * the job queue — an audition is not something to persist, download, or
 * count against the storage budget.
 */

import type { TTSModel, Voice } from './engine';

/**
 * The line every audition speaks.
 *
 * Short on purpose: Kokoro is several seconds of wall clock for a preview and
 * this text has to survive that on every click. It is also deliberately
 * first-person and contains an em dash, so it exercises the prosody that
 * distinguishes one voice from another instead of reading like a test tone.
 */
export const PREVIEW_TEXT =
  'Hi — here is a sample of how I will read your text aloud.';

/**
 * Locale tags the model definitions use, in words. A reader should not need
 * to know that `en-gb` means British English.
 */
const ACCENT_LABELS: Record<string, string> = {
  'en-us': 'American',
  'en-gb': 'British',
  'en-au': 'Australian',
  'en-in': 'Indian',
  'en-es': 'Spanish (Spain)',
};

/** Display order for accents, so the common ones sort to the top. */
const ACCENT_ORDER = ['American', 'British', 'Australian', 'Indian', 'Spanish (Spain)'];

function labelForAccent(locale: string): string {
  return ACCENT_LABELS[locale.toLowerCase()] ?? locale.toUpperCase();
}

function genderFromText(text: string): string {
  if (/\bfemale\b|\bwoman\b/i.test(text)) return 'Female';
  if (/\bmale\b|\bman\b/i.test(text)) return 'Male';
  return '';
}

/**
 * Pull the accent and gender out of a voice's name or description.
 *
 * The registries encode this in prose rather than as fields — Kokoro ships
 * `"Sarah (en-us, Female)"`, Kitten ships `description: "Female voice (Kitten
 * TTS Nano v0.8)"`, SpeechT5 ships `"Neutral US English, male. Public xvector
 * from transformers.js docs."`. Adding a real `accent`/`gender` field to the
 * `Voice` interface would be the real fix, but these lists are transcribed
 * from upstream model cards and the prose is what they actually publish.
 */
export function parseVoiceTraits(voice: Voice): { accent: string; gender: string } {
  const name = voice.name ?? '';
  const desc = voice.description ?? '';
  const combined = `${name} ${desc}`;

  // Kokoro's exact shape: a trailing "(en-us, Female)".
  const tail = name.match(/\(([^()]*)\)\s*$/);
  const parts = (tail?.[1] ?? '').split(',').map(p => p.trim()).filter(Boolean);
  const locale = parts.find(p => /^[a-z]{2}-[a-z]{2}$/i.test(p));
  const genderWord = parts.find(p => /^(female|male)$/i.test(p));

  const accent = locale
    ? labelForAccent(locale)
    // SpeechT5 writes "Neutral US English" rather than a tag.
    : /\bus english\b/i.test(combined) ? 'American'
    : /\buk english\b|\bbritish\b/i.test(combined) ? 'British'
    : '';

  const gender = genderWord
    ? genderWord[0].toUpperCase() + genderWord.slice(1).toLowerCase()
    : genderFromText(combined);

  return { accent, gender };
}

/** One voice, resolved into the pieces the picker renders separately. */
export interface VoicePresentation {
  voice: Voice;
  /** Name with the "(en-us, Female)" tail stripped — the card shows traits separately. */
  name: string;
  accent: string;
  gender: string;
}

/** A labelled run of voices. `label` is '' when the model has nothing to group by. */
export interface VoiceGroup {
  label: string;
  items: VoicePresentation[];
}

function stripTraitTail(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name.trim();
}

/**
 * A voice's name as a person would say it out loud, traits included.
 *
 * The registries carry the traits inside the display name ("Heart
 * (en-us, Female)"), which is fine in a list of names and wrong the moment
 * the same string is used anywhere else: the queue card was rendering
 * "Kokoro-82M (int8) · Heart (en-us, Female)" while the picker beside it
 * said "Heart". One formatter, both surfaces.
 */
export function voiceDisplayLabel(voiceName: string): string {
  const traits = parseVoiceTraits({ id: '', name: voiceName });
  const suffix = [traits.accent, traits.gender].filter(Boolean).join(', ');
  const base = stripTraitTail(voiceName);
  return suffix ? `${base} · ${suffix}` : base;
}

function labelFor(accent: string, gender: string): string {
  if (accent && gender) return `${accent} ${gender}`;
  if (gender) return gender;
  return accent;
}

function compareGroups(
  a: { accent: string; gender: string },
  b: { accent: string; gender: string },
): number {
  // A voice with no accent at all sorts last — it tells the reader least.
  if (!a.accent !== !b.accent) return a.accent ? -1 : 1;
  if (a.accent && a.accent !== b.accent) {
    const ai = ACCENT_ORDER.indexOf(a.accent);
    const bi = ACCENT_ORDER.indexOf(b.accent);
    if (ai !== bi) return (ai === -1 ? ACCENT_ORDER.length : ai) - (bi === -1 ? ACCENT_ORDER.length : bi);
    return a.accent.localeCompare(b.accent);
  }
  // Same accent (or none at all): Female before Male.
  if (a.gender === b.gender) return 0;
  if (a.gender === 'Female') return -1;
  if (b.gender === 'Female') return 1;
  return 0;
}

/**
 * Group a model's voices for display.
 *
 * A model that has nothing to say about its voices (SpeechT5's two xvector
 * presets) comes back as a single unlabelled group, so the picker renders the
 * plain list it always did instead of an empty-looking heading.
 */
export function groupVoices(voices: Voice[]): VoiceGroup[] {
  // Keyed by label, but the accent and gender are kept alongside it: the
  // display order is an accent-then-gender order, and "American Female" is
  // not a member of the accent table.
  const groups = new Map<string, { accent: string; gender: string; items: VoicePresentation[] }>();

  for (const voice of voices) {
    const { accent, gender } = parseVoiceTraits(voice);
    const item: VoicePresentation = {
      voice,
      name: stripTraitTail(voice.name ?? voice.id),
      accent,
      gender,
    };
    const label = labelFor(accent, gender);
    const bucket = groups.get(label);
    if (bucket) bucket.items.push(item);
    else groups.set(label, { accent, gender, items: [item] });
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => compareGroups(a, b))
    .map(([label, { items }]) => {
      // Female before Male inside a shared accent heading. Voices with no
      // gender keep their registry order at the end of their group.
      const sorted = [...items].sort((a, b) => {
        if (a.gender === b.gender) return 0;
        if (a.gender === 'Female') return -1;
        if (b.gender === 'Female') return 1;
        if (!a.gender) return 1;
        if (!b.gender) return -1;
        return 0;
      });
      return { label, items: sorted };
    });
}

// ─── Playback ─────────────────────────────────────────────────────

/** What the player needs from the platform to make sound. Injectable for tests. */
export interface PreviewSink {
  /**
   * Play `url` and resolve when the clip has FINISHED (or failed). Resolving
   * on finish rather than on start is what lets the UI keep a voice marked
   * "playing" for the length of the sample.
   */
  play(url: string): Promise<void>;
  /** Stop whatever is playing and settle its pending play() call. */
  stop(): void;
}

/**
 * The real sink: one <audio> element, reused.
 *
 * A single element rather than one per card is deliberate — a grid of 28
 * armed Audio objects is 28 chances to leak a decode buffer, and the app
 * already has an <audio> somewhere for job playback that we would rather not
 * fight with. Detaching by clearing `src` releases the decoder immediately
 * instead of waiting for garbage collection.
 */
export function createAudioSink(): PreviewSink {
  let audio: HTMLAudioElement | null = null;
  let settle: (() => void) | null = null;

  const finish = (): void => {
    const done = settle;
    settle = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio = null;
    }
    done?.();
  };

  return {
    play(url: string): Promise<void> {
      // Starting a new clip supersedes the old one.
      finish();
      return new Promise<void>(resolve => {
        settle = resolve;
        const el = new Audio(url);
        audio = el;
        el.addEventListener('ended', finish, { once: true });
        el.addEventListener('error', finish, { once: true });
        // A rejected play() means the browser refused (usually autoplay
        // policy). Surface it as a failed clip rather than hanging forever
        // on a promise that will never resolve.
        el.play().catch(finish);
      });
    },
    stop: finish,
  };
}

/**
 * Drives audition for the picker: one clip at a time, and a click on the
 * voice that is already playing stops it rather than re-synthesising.
 *
 * Synthesis is slow enough (seconds) that the user will click again while it
 * runs. A monotonically increasing token is what keeps that from going wrong:
 * a superseded generate() still resolves eventually, and this is how we know
 * to throw its audio away instead of playing a clip for the wrong voice.
 */
export class VoicePreviewPlayer {
  /** Voice currently being synthesised or played, or null when idle. */
  activeVoiceId: string | null = null;
  private token = 0;
  private lastUrl: string | null = null;

  constructor(private readonly sink: PreviewSink) {}

  get busy(): boolean {
    return this.activeVoiceId !== null;
  }

  /** True when this voice's clip is the one on screen right now. */
  isActive(voiceId: string): boolean {
    return this.activeVoiceId === voiceId;
  }

  /**
   * Synthesise and play `voiceId`. Rejects if generation fails, so the
   * caller can show why. Clicking the active voice toggles it off.
   */
  async audition(voiceId: string, generate: (voiceId: string) => Promise<Blob>): Promise<'played' | 'stopped'> {
    if (this.activeVoiceId === voiceId) {
      this.stop();
      return 'stopped';
    }
    const token = ++this.token;
    this.stopPlayback();
    this.activeVoiceId = voiceId;

    let blob: Blob;
    try {
      blob = await generate(voiceId);
    } catch (err) {
      if (token === this.token) this.activeVoiceId = null;
      throw err;
    }
    // Superseded while synthesising — someone clicked another voice.
    if (token !== this.token) return 'stopped';

    this.revokeLastUrl();
    this.lastUrl = URL.createObjectURL(blob);
    try {
      await this.sink.play(this.lastUrl);
    } finally {
      if (token === this.token) this.activeVoiceId = null;
    }
    return 'played';
  }

  /** Stop playback and mark the player idle. Does not touch a pending generate. */
  stop(): void {
    this.token++;
    this.activeVoiceId = null;
    this.stopPlayback();
  }

  /** Release the object URL of the last generated clip. */
  dispose(): void {
    this.stop();
    this.revokeLastUrl();
  }

  private stopPlayback(): void {
    this.sink.stop();
  }

  private revokeLastUrl(): void {
    if (this.lastUrl) {
      URL.revokeObjectURL(this.lastUrl);
      this.lastUrl = null;
    }
  }
}

/** Pronoun-free, model-agnostic copy for the audition button. */
export function previewButtonLabel(playing: boolean): string {
  return playing ? '■ Stop' : '▶ Hear it';
}

/**
 * Whether this model's voice cards get a "Hear it" button.
 *
 * Two conditions, and both are load-bearing:
 *
 *   - `custom` — auditioning goes through TTSEngine.preview(), which talks to
 *     a registered custom engine. The main-thread transformers.js models
 *     cannot be previewed, and neither can they be auditioned without
 *     freezing the page mid-synthesis.
 *   - more than one voice — a model with a single fixed voice has nothing to
 *     choose between, so a "Hear it" would be a button that only confirms
 *     what is already on screen.
 *
 * SpeechT5 is the interesting rejection: it lists two "voices", but they are
 * xvector presets on a main-thread model, so the picker lists them without
 * audition buttons. That is the intended reading of the rule, not an
 * oversight.
 */
export function supportsVoicePreview(model: TTSModel): boolean {
  return Boolean(model.custom) && (model.voices?.length ?? 0) > 1;
}
