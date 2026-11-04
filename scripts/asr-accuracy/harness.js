// ASR accuracy harness — runs the app's real pipeline against real speech.
// Served from public/ so the page can fetch it; imports the app's own
// modules, so this measures the shipped code path, not a copy of it.

const CASES = [
  { id: 'plain', text: 'The quick brown fox jumps over the lazy dog.' },
  { id: 'names', text: 'Doctor Reyes prescribed two hundred milligrams of ibuprofen.' },
  { id: 'acronym', text: 'The SQL query returned thirty seven rows in four seconds.' },
  { id: 'numbers', text: 'Please read chapter twelve before Friday\'s seminar.' },
  { id: 'heteronym', text: 'I read the book yesterday and now I will read it again.' },
  { id: 'email', text: 'Email me at jordan dot lee at example dot com.' },
  { id: 'medical', text: 'The patient\'s blood pressure was one twenty over eighty.' },
  { id: 'directions', text: 'Turn left at the second traffic light then continue for three blocks.' },
];

/** Words as a reader would compare them: lowercase, punctuation dropped. */
function words(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Whisper rewrites spoken numbers as digits — "two hundred" comes back
// "200". That is the model doing its job, so scoring it as a substitution
// would understate accuracy. Collapse every number, digit or word, to one
// placeholder on both sides. The caveat is honest: a *wrong* number still
// scores as right, so the per-case transcripts are printed alongside and
// read by eye.
const NUMBER_WORDS = new Set([
  'zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen',
  'eighteen','nineteen','twenty','thirty','forty','fifty','sixty','seventy',
  'eighty','ninety','hundred','thousand','million','billion',
]);

function canonicalWords(text) {
  return words(text).map((word) =>
    /^\d+$/.test(word) || NUMBER_WORDS.has(word) ? '<num>' : word,
  );
}

/** Standard word error rate: substitutions + deletions + insertions / reference. */
function wer(reference, hypothesis, tokenize = words) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  const prev = new Array(hyp.length + 1);
  for (let j = 0; j <= hyp.length; j++) prev[j] = j;
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= hyp.length; j++) prev[j] = cur[j];
  }
  return prev[hyp.length] / ref.length;
}

export async function run() {
  const asr = await import('/src/asr.ts');
  const engine = await import('/src/engines/whisper-asr.ts');
  const RATE = 16000;

  const report = { status: 'loading', cases: [], degenerate: [] };
  window.__asrTest = report;

  await engine.loadAsrModel({
    id: 'onnx-community/whisper-tiny.en',
    label: 'en',
    languages: 'English',
    downloadMb: 41,
    multilingual: false,
  });
  report.status = 'running';

  const ctx = new AudioContext();

  for (const testCase of CASES) {
    const response = await fetch(`/.asr-fixtures/${testCase.id}.wav`);
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());

    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));

    // The exact chain the dictation UI runs.
    const mono = asr.downmix(channels);
    const resampled = asr.resample(mono, buffer.sampleRate, RATE);
    const trimmed = asr.trimSilence(resampled, RATE);
    const silent = asr.isSilent(trimmed);
    const speech = asr.looksLikeSpeech(trimmed, RATE);

    let transcript = '';
    let ms = 0;
    if (!silent && speech) {
      const started = performance.now();
      // Exactly what dictation.ts does: hand the whole recording over and
      // let the pipeline chunk it with its own stride.
      transcript = await engine.transcribeAudio(trimmed);
      ms = Math.round(performance.now() - started);
    }

    report.cases.push({
      id: testCase.id,
      sourceRate: buffer.sampleRate,
      seconds: Math.round(buffer.duration * 100) / 100,
      gatedOut: silent || !speech,
      expected: testCase.text,
      transcript,
      wer: Math.round(wer(testCase.text, transcript, canonicalWords) * 1000) / 1000,
      werRaw: Math.round(wer(testCase.text, transcript) * 1000) / 1000,
      ms,
    });
    window.__asrTest = report;
  }

  // Sample-rate robustness: the microphone rate is whatever the OS picked.
  // Round-trip a fixture up to 48 kHz and back down through the same
  // resampler, and the transcript must not change.
  {
    const response = await fetch('/.asr-fixtures/plain.wav');
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    const mono = asr.downmix(channels);
    const at48k = asr.resample(mono, buffer.sampleRate, 44100);
    const back = asr.resample(at48k, 44100, RATE);
    const trimmed = asr.trimSilence(back, RATE);
    const text = await engine.transcribeAudio(trimmed);
    report.rateTest = {
      from: buffer.sampleRate,
      via: 44100,
      transcript: text,
      wer: Math.round(wer(CASES[0].text, text, canonicalWords) * 1000) / 1000,
    };
  }

  // Quiet speech: the same words at 2% amplitude. A soft speaker must not
  // be gated out, and the trim must not cut them to a fragment.
  {
    const response = await fetch('/.asr-fixtures/plain.wav');
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    const mono = asr.downmix(channels);
    const quiet = new Float32Array(mono.length);
    for (let i = 0; i < quiet.length; i++) quiet[i] = mono[i] * 0.02;

    const resampled = asr.resample(quiet, buffer.sampleRate, RATE);
    const trimmed = asr.trimSilence(resampled, RATE);
    const silent = asr.isSilent(trimmed);
    const speech = asr.looksLikeSpeech(trimmed, RATE);
    report.quiet = {
      peak: Math.round(asr.peakLevel(trimmed) * 10000) / 10000,
      keptRatio: Math.round((trimmed.length / Math.max(resampled.length, 1)) * 1000) / 1000,
      silent,
      speech,
      gatedOut: silent || !speech,
      transcript: null,
    };
    if (!silent && speech) {
      report.quiet.transcript = await engine.transcribeAudio(trimmed);
      report.quiet.wer = Math.round(wer(CASES[0].text, report.quiet.transcript, canonicalWords) * 1000) / 1000;
    }
  }

  // A very short clip: no crash, and an honest (possibly empty) result.
  {
    const response = await fetch('/.asr-fixtures/plain.wav');
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    const resampled = asr.resample(asr.downmix(channels), buffer.sampleRate, RATE);
    const short = resampled.subarray(0, Math.floor(RATE * 0.5));
    const trimmed = asr.trimSilence(short, RATE);
    report.short = {
      samples: short.length,
      silent: asr.isSilent(trimmed),
      speech: asr.looksLikeSpeech(trimmed, RATE),
      transcript:
        asr.isSilent(trimmed) || !asr.looksLikeSpeech(trimmed, RATE)
          ? null
          : await engine.transcribeAudio(trimmed),
    };
  }

  // Degenerate inputs: both must be rejected before inference.
  const silence = new Float32Array(RATE * 2);
  const tone = new Float32Array(RATE * 2);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE);

  for (const [label, samples] of [['silence', silence], ['tone', tone]]) {
    const trimmed = asr.trimSilence(samples, RATE);
    report.degenerate.push({
      label,
      silent: asr.isSilent(trimmed),
      speech: asr.looksLikeSpeech(trimmed, RATE),
      rejected: asr.isSilent(trimmed) || !asr.looksLikeSpeech(trimmed, RATE),
    });
  }

  const scored = report.cases.filter((c) => !c.gatedOut);
  report.summary = {
    cases: report.cases.length,
    gatedOut: report.cases.length - scored.length,
    meanWer: scored.length
      ? Math.round((scored.reduce((sum, c) => sum + c.wer, 0) / scored.length) * 1000) / 1000
      : null,
    meanWerRaw: scored.length
      ? Math.round((scored.reduce((sum, c) => sum + c.werRaw, 0) / scored.length) * 1000) / 1000
      : null,
    exactMatches: scored.filter((c) => c.wer === 0).length,
    meanMs: scored.length
      ? Math.round(scored.reduce((sum, c) => sum + c.ms, 0) / scored.length)
      : null,
    rateTestWer: report.rateTest ? report.rateTest.wer : null,
    degenerateRejected: report.degenerate.every((d) => d.rejected),
  };
  report.status = 'done';
  window.__asrTest = report;
  return report.summary;
}
