import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PREVIEW_TEXT,
  VoicePreviewPlayer,
  groupVoices,
  parseVoiceTraits,
  previewButtonLabel,
  supportsVoicePreview,
  voiceDisplayLabel,
  type PreviewSink,
} from './voice-preview';
import { KOKORO_VOICES } from './engines/kokoro';
import { KITTEN_VOICES } from './engines/kitten';
import { MODELS, type Voice } from './engine';

function voicesOf(modelId: string): Voice[] {
  const m = MODELS.find(x => x.id === modelId);
  if (!m) throw new Error(`no model ${modelId}`);
  return m.voices ?? [];
}

describe('parseVoiceTraits', () => {
  it("reads Kokoro's \"Name (en-us, Female)\" shape", () => {
    expect(parseVoiceTraits({ id: 'af_heart', name: 'Heart (en-us, Female)' }))
      .toEqual({ accent: 'American', gender: 'Female' });
    expect(parseVoiceTraits({ id: 'bm_george', name: 'George (en-gb, Male)' }))
      .toEqual({ accent: 'British', gender: 'Male' });
  });

  it("reads Kitten's prose description", () => {
    expect(parseVoiceTraits(KITTEN_VOICES[1]))
      .toEqual({ accent: '', gender: 'Female' });
  });

  it("reads SpeechT5's \"Neutral US English, male.\" description", () => {
    expect(parseVoiceTraits(voicesOf('speecht5')[0]))
      .toEqual({ accent: 'American', gender: 'Male' });
  });

  it('returns nothing rather than guessing', () => {
    expect(parseVoiceTraits({ id: 'x', name: 'Custom (paste URL)', description: 'Provide your own .bin file URL.' }))
      .toEqual({ accent: '', gender: '' });
  });

  it('does not read "female" as "male"', () => {
    expect(parseVoiceTraits({ id: 'x', name: 'Ava', description: 'A warm female narrator.' }).gender)
      .toBe('Female');
  });
});

describe('groupVoices', () => {
  it("splits Kokoro's 28 voices into American/British x Female/Male", () => {
    const groups = groupVoices(KOKORO_VOICES);
    expect(groups.map(g => g.label)).toEqual([
      'American Female', 'American Male', 'British Female', 'British Male',
    ]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(28);
  });

  it('orders American before British and female before male', () => {
    const groups = groupVoices(KOKORO_VOICES);
    const american = groups[0].items.map(i => i.voice.id);
    expect(american).toContain('af_heart');
    expect(american).not.toContain('bf_emma');
    expect(groups[1].items.every(i => i.voice.id.startsWith('am_'))).toBe(true);
  });

  it('strips the trait tail off the displayed name', () => {
    const heart = groupVoices(KOKORO_VOICES)[0].items[0];
    expect(heart.name).toBe('Heart');
  });

  it('collapses a model with no trait data into one unlabelled group', () => {
    const groups = groupVoices([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('');
    expect(groups[0].items.map(i => i.voice.id)).toEqual(['a', 'b']);
  });

  it('puts unlabelled voices last so described ones lead', () => {
    const groups = groupVoices([
      { id: 'plain', name: 'Plain' },
      { id: 'us', name: 'Nova (en-us, Female)' },
    ]);
    expect(groups.map(g => g.label)).toEqual(['American Female', '']);
  });

  it('groups Kitten by gender alone, with no accent heading', () => {
    const groups = groupVoices(KITTEN_VOICES);
    expect(groups.map(g => g.label)).toEqual(['Female', 'Male']);
    expect(groups[0].items).toHaveLength(4);
  });

  it('falls back to the id when a voice has no name', () => {
    const groups = groupVoices([{ id: 'anon' }]);
    expect(groups[0].items[0].name).toBe('anon');
  });
});

describe('voiceDisplayLabel', () => {
  it('renders the registry name the way the picker does', () => {
    expect(voiceDisplayLabel('Heart (en-us, Female)')).toBe('Heart · American, Female');
    expect(voiceDisplayLabel('Voice 2 (Male)')).toBe('Voice 2 · Male');
  });

  it('leaves a name with no traits alone', () => {
    expect(voiceDisplayLabel('CMU Arctic (default)')).toBe('CMU Arctic');
  });
});

describe('previewButtonLabel', () => {  it('reads as an action in both states', () => {
    expect(previewButtonLabel(false)).toContain('Hear it');
    expect(previewButtonLabel(true)).toContain('Stop');
  });
});

describe('PREVIEW_TEXT', () => {
  it('is one short sentence — a preview pays real synthesis latency', () => {
    expect(PREVIEW_TEXT.split(/\s+/).length).toBeLessThan(20);
    expect(PREVIEW_TEXT.endsWith('.')).toBe(true);
  });
});

describe('supportsVoicePreview', () => {
  it('offers audition for the worker-backed multi-voice models', () => {
    const kokoro = MODELS.find(m => m.id === 'kokoro-82m')!;
    const kitten = MODELS.find(m => m.id === 'kitten-nano')!;
    expect(supportsVoicePreview(kokoro)).toBe(true);
    expect(supportsVoicePreview(kitten)).toBe(true);
  });

  it('does not offer it for a main-thread model with "voices"', () => {
    // SpeechT5 lists two xvector presets, but auditioning it would mean
    // freezing the page for a sample, and its engine is not previewable.
    expect(supportsVoicePreview(MODELS.find(m => m.id === 'speecht5')!)).toBe(false);
  });

  it('does not offer it for a model with a single fixed voice', () => {
    const mms = MODELS.find(m => m.id === 'mms-tts-eng')!;
    expect(mms.voices).toEqual([]);
    expect(supportsVoicePreview(mms)).toBe(false);
    expect(supportsVoicePreview({ ...kokoroLike(), voices: [{ id: 'only', name: 'Only' }] })).toBe(false);
  });
});

function kokoroLike() {
  return MODELS.find(m => m.id === 'kokoro-82m')!;
}

// ─── Playback ───────────────────────────────────────────────────

class FakeSink implements PreviewSink {
  played: string[] = [];
  stops = 0;
  /** When true, play() stays pending until endAll()/stop() settles it. */
  manual = false;
  private resolvers: (() => void)[] = [];

  play(url: string): Promise<void> {
    this.played.push(url);
    if (!this.manual) return Promise.resolve();
    return new Promise<void>(resolve => { this.resolvers.push(resolve); });
  }

  /** Simulate the clip reaching its end. */
  endAll(): void {
    const pending = this.resolvers;
    this.resolvers = [];
    for (const resolve of pending) resolve();
  }

  stop(): void {
    this.stops++;
    this.endAll();
  }
}

describe('VoicePreviewPlayer', () => {
  let sink: FakeSink;
  let player: VoicePreviewPlayer;

  beforeEach(() => {
    sink = new FakeSink();
    player = new VoicePreviewPlayer(sink);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays a generated clip and clears the active voice when it ends', async () => {
    const blob = new Blob(['wav'], { type: 'audio/wav' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:1');
    const result = await player.audition('af_heart', async () => blob);
    expect(result).toBe('played');
    expect(create).toHaveBeenCalledWith(blob);
    expect(sink.played).toEqual(['blob:1']);
    expect(player.activeVoiceId).toBeNull();
    expect(player.busy).toBe(false);
  });

  it('stays marked active for the length of the clip', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:1');
    sink.manual = true;
    const pending = player.audition('af_heart', async () => new Blob([]));
    await vi.waitFor(() => expect(sink.played).toHaveLength(1));
    expect(player.isActive('af_heart')).toBe(true);
    sink.endAll();
    await pending;
    expect(player.isActive('af_heart')).toBe(false);
  });

  it('does not re-synthesise when the active voice is clicked again', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:1');
    sink.manual = true;
    const generate = vi.fn(async () => new Blob([]));
    const first = player.audition('af_heart', generate);
    await vi.waitFor(() => expect(sink.played).toHaveLength(1));
    const second = await player.audition('af_heart', generate);
    expect(second).toBe('stopped');
    await first;
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('discards audio from a superseded audition instead of playing it', async () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`);
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(r => { releaseSlow = r; });
    const slow = player.audition('af_heart', async () => {
      await slowGate;
      return new Blob(['slow']);
    });
    // Second click while the first is still synthesising.
    const fast = await player.audition('am_adam', async () => new Blob(['fast']));
    expect(fast).toBe('played');
    // The superseded clip arrives after the newer one and must never sound.
    expect(sink.played).toEqual(['blob:1']);
    releaseSlow();
    await expect(slow).resolves.toBe('stopped');
    expect(sink.played).toEqual(['blob:1']);
    expect(player.activeVoiceId).toBeNull();
  });

  it('propagates a generation failure and frees the slot', async () => {
    const boom = new Error('model exploded');
    await expect(player.audition('af_heart', async () => { throw boom; })).rejects.toThrow('model exploded');
    expect(player.activeVoiceId).toBeNull();
    // ...and the next audition is not blocked by it.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:1');
    await expect(player.audition('am_adam', async () => new Blob([]))).resolves.toBe('played');
  });

  it('revokes the previous clip URL rather than leaking it', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:1');
    await player.audition('af_heart', async () => new Blob([]));
    await player.audition('am_adam', async () => new Blob([]));
    expect(revoke).toHaveBeenCalledWith('blob:1');
    player.dispose();
    expect(revoke).toHaveBeenCalledWith('blob:1');
  });
});
