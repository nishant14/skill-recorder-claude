/**
 * Decide whether an analyze run must transcribe the session's voice narration
 * first. Kept as a tiny pure module (no electron / transcription imports) so the rule
 * is unit-testable in isolation and shared by the analyze flow.
 *
 * The narration is the user's own words describing their intent, so analysis
 * must never silently run without it when it's available but not yet
 * transcribed. We only transcribe-then-analyze when there is saved audio and no
 * usable transcript yet; a session with no audio, or one already transcribed,
 * analyzes straight away.
 */
export function shouldTranscribeBeforeAnalyze(hasAudio: boolean, hasTranscript: boolean): boolean {
  return hasAudio && !hasTranscript;
}
