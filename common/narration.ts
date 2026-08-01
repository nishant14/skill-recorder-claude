export const NARRATION_LANGUAGES = [
  { code: "af", label: "Afrikaans" },
  { code: "sq", label: "Albanian" },
  { code: "am", label: "Amharic" },
  { code: "ar", label: "Arabic" },
  { code: "hy", label: "Armenian" },
  { code: "as", label: "Assamese" },
  { code: "az", label: "Azerbaijani" },
  { code: "ba", label: "Bashkir" },
  { code: "eu", label: "Basque" },
  { code: "be", label: "Belarusian" },
  { code: "bn", label: "Bengali" },
  { code: "bs", label: "Bosnian" },
  { code: "br", label: "Breton" },
  { code: "bg", label: "Bulgarian" },
  { code: "ca", label: "Catalan" },
  { code: "zh", label: "Chinese" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "et", label: "Estonian" },
  { code: "fo", label: "Faroese" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "gl", label: "Galician" },
  { code: "ka", label: "Georgian" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "gu", label: "Gujarati" },
  { code: "ht", label: "Haitian Creole" },
  { code: "ha", label: "Hausa" },
  { code: "haw", label: "Hawaiian" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "is", label: "Icelandic" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "jw", label: "Javanese" },
  { code: "kn", label: "Kannada" },
  { code: "kk", label: "Kazakh" },
  { code: "km", label: "Khmer" },
  { code: "ko", label: "Korean" },
  { code: "lo", label: "Lao" },
  { code: "la", label: "Latin" },
  { code: "lv", label: "Latvian" },
  { code: "ln", label: "Lingala" },
  { code: "lt", label: "Lithuanian" },
  { code: "lb", label: "Luxembourgish" },
  { code: "mk", label: "Macedonian" },
  { code: "mg", label: "Malagasy" },
  { code: "ms", label: "Malay" },
  { code: "ml", label: "Malayalam" },
  { code: "mt", label: "Maltese" },
  { code: "mi", label: "Maori" },
  { code: "mr", label: "Marathi" },
  { code: "mn", label: "Mongolian" },
  { code: "my", label: "Myanmar" },
  { code: "ne", label: "Nepali" },
  { code: "no", label: "Norwegian" },
  { code: "nn", label: "Nynorsk" },
  { code: "oc", label: "Occitan" },
  { code: "ps", label: "Pashto" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "pa", label: "Punjabi" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sa", label: "Sanskrit" },
  { code: "sr", label: "Serbian" },
  { code: "sn", label: "Shona" },
  { code: "sd", label: "Sindhi" },
  { code: "si", label: "Sinhala" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "so", label: "Somali" },
  { code: "es", label: "Spanish" },
  { code: "su", label: "Sundanese" },
  { code: "sw", label: "Swahili" },
  { code: "sv", label: "Swedish" },
  { code: "tl", label: "Tagalog" },
  { code: "tg", label: "Tajik" },
  { code: "ta", label: "Tamil" },
  { code: "tt", label: "Tatar" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "bo", label: "Tibetan" },
  { code: "tr", label: "Turkish" },
  { code: "tk", label: "Turkmen" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "uz", label: "Uzbek" },
  { code: "vi", label: "Vietnamese" },
  { code: "cy", label: "Welsh" },
  { code: "yi", label: "Yiddish" },
  { code: "yo", label: "Yoruba" },
] as const;

export type NarrationLanguage = (typeof NARRATION_LANGUAGES)[number]["code"];

export const DEFAULT_NARRATION_LANGUAGE: NarrationLanguage = "en";

export function isNarrationLanguage(value: unknown): value is NarrationLanguage {
  return (
    typeof value === "string" &&
    NARRATION_LANGUAGES.some(({ code }) => code === value)
  );
}

export function narrationLanguageLabel(language: NarrationLanguage): string {
  const match = NARRATION_LANGUAGES.find(({ code }) => code === language);
  if (!match) throw new Error(`Unsupported narration language: ${language}`);
  return match.label;
}

/**
 * The voice-narration transcript. This is the spoken form of the typed marker: the
 * user's own stated intent while recording. It is produced after Stop by the
 * narration stage — the recorded audio is sent to the user's own Azure AI Foundry
 * transcription deployment — and written to `narration.json`. It is NEVER appended
 * to the finalized `events.jsonl`; the describer reads it through the
 * `get_narration` tool.
 */
export interface NarrationSegment {
  /** Segment start, in ms since the session started (same clock as step offsets). */
  atMs: number;
  /** Segment end, in ms since the session started. */
  endMs: number;
  /** The spoken text for this segment. */
  text: string;
}

export interface NarrationTranscript {
  /** The transcription deployment that produced this transcript. */
  model: string;
  /** The explicitly selected source language, preserved rather than translated. */
  language: NarrationLanguage;
  segments: NarrationSegment[];
}

/** Filename of the transcript within a session folder. */
export const NARRATION_FILE = "narration.json";
