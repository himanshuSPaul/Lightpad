import { LanguageDescription, StreamLanguage } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

// Windows batch files aren't in language-data, so here's a small tokenizer for them.
const batchKeywords = new Set(
  ("if else for in do goto call exit set setlocal endlocal echo off on not exist defined errorlevel " +
    "equ neq lss leq gtr geq shift pause cd chdir pushd popd start title cls copy move del ren mkdir rmdir")
    .split(" ")
);
const batch = StreamLanguage.define({
  name: "batch",
  languageData: { commentTokens: { line: "REM" } }, // so Ctrl+/ comments lines with REM, like Notepad++
  startState: () => ({ lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true;
    if (stream.eatSpace()) return null;
    const first = state.lineStart;
    state.lineStart = false;
    if (first && stream.match(/^@?(rem\b|::)/i)) {
      stream.skipToEnd();
      return "comment";
    }
    if (first && stream.match(/^:\w+/)) return "labelName";
    if (stream.match(/^%~?[\w]+%?|^![\w]+!|^%%\w/)) return "variableName";
    if (stream.match(/^"[^"]*"?/)) return "string";
    if (stream.match(/^[0-9]+\b/)) return "number";
    if (stream.match(/^[&|<>()]+/)) return "operator";
    if (stream.match(/^@?[\w.-]+/)) {
      const word = stream.current().replace(/^@/, "").toLowerCase();
      return batchKeywords.has(word) ? "keyword" : null;
    }
    stream.next();
    return null;
  },
});

const PLAIN = LanguageDescription.of({ name: "Plain Text", extensions: ["txt", "log"], support: [] });

export const LANGUAGES = [
  ...languages,
  LanguageDescription.of({ name: "Batch File", extensions: ["bat", "cmd"], load: async () => batch }),
  PLAIN,
].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

export function detectLanguage(path) {
  const name = (path || "").split(/[\\/]/).pop();
  return (name && LanguageDescription.matchFilename(LANGUAGES, name)) || PLAIN;
}

export const languageByName = (name) => LANGUAGES.find((l) => l.name === name) || null;

// Language support is loaded lazily, so only the languages actually used get downloaded.
export async function loadLanguage(desc) {
  if (desc === PLAIN) return [];
  return desc.support || (await desc.load());
}
