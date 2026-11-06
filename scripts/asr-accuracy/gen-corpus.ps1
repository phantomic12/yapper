# Synthesises a real-speech test corpus with known ground truth.
# Two SAPI voices, two rates, so the harness sees different pitch,
# timbre and speaking speed rather than one synthetic monotone.
Add-Type -AssemblyName System.Speech

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$outDir = Join-Path $repoRoot "public\.asr-fixtures"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
# The harness is served from public/ so the page can import it. A copy is
# placed beside the fixtures; this script is the source of truth.
Copy-Item (Join-Path $PSScriptRoot "harness.js") $outDir -Force

$cases = @(
  @{ id = "plain";     voice = "Microsoft David Desktop"; rate = 0;  text = "The quick brown fox jumps over the lazy dog." },
  @{ id = "names";     voice = "Microsoft Zira Desktop";  rate = 0;  text = "Doctor Reyes prescribed two hundred milligrams of ibuprofen." },
  @{ id = "acronym";   voice = "Microsoft David Desktop"; rate = 1;  text = "The SQL query returned thirty seven rows in four seconds." },
  @{ id = "numbers";   voice = "Microsoft Zira Desktop";  rate = 1;  text = "Please read chapter twelve before Friday's seminar." },
  @{ id = "heteronym"; voice = "Microsoft David Desktop"; rate = -1; text = "I read the book yesterday and now I will read it again." },
  @{ id = "email";     voice = "Microsoft Zira Desktop";  rate = 0;  text = "Email me at jordan dot lee at example dot com." },
  @{ id = "medical";   voice = "Microsoft David Desktop"; rate = -1; text = "The patient's blood pressure was one twenty over eighty." },
  @{ id = "directions";voice = "Microsoft Zira Desktop";  rate = 1;  text = "Turn left at the second traffic light then continue for three blocks." }
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$manifest = @()

foreach ($case in $cases) {
  $path = Join-Path $outDir ($case.id + ".wav")
  $synth.SelectVoice($case.voice)
  $synth.Rate = $case.rate
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($case.text)
  $synth.SetOutputToNull()

  $info = New-Object System.IO.FileInfo($path)
  $manifest += [pscustomobject]@{
    id       = $case.id
    file     = ".asr-fixtures/" + $case.id + ".wav"
    text     = $case.text
    voice    = $case.voice
    rate     = $case.rate
    bytes    = $info.Length
  }
}

# Silence and a steady tone are synthesised in the harness instead — SAPI
# cannot speak silence, and a hand-built Float32Array pins the exact level.
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $PSScriptRoot "manifest.json") -Encoding UTF8
$synth.Dispose()

Write-Output "generated $($manifest.Count) speech files"
$manifest | ForEach-Object { Write-Output ("  {0,-11} {1,7} bytes  {2}" -f $_.id, $_.bytes, $_.text) }
