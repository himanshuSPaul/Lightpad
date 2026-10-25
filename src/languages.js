import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";

const LANGS = [
  { name: "JavaScript", exts: ["js", "mjs", "cjs", "jsx"], load: () => javascript({ jsx: true }) },
  { name: "TypeScript", exts: ["ts", "tsx", "mts", "cts"], load: () => javascript({ typescript: true, jsx: true }) },
  { name: "Python", exts: ["py", "pyw"], load: python },
  { name: "HTML", exts: ["html", "htm", "vue", "svelte"], load: html },
  { name: "CSS", exts: ["css", "scss", "less"], load: css },
  { name: "JSON", exts: ["json", "jsonc"], load: json },
  { name: "Markdown", exts: ["md", "markdown"], load: markdown },
  { name: "Rust", exts: ["rs"], load: rust },
  { name: "C/C++", exts: ["c", "h", "cpp", "cc", "cxx", "hpp", "hh"], load: cpp },
  { name: "Java", exts: ["java", "kt", "cs"], load: java },
  { name: "XML", exts: ["xml", "svg", "xaml", "csproj", "plist"], load: xml },
  { name: "SQL", exts: ["sql"], load: sql },
];

export function languageFor(path) {
  const ext = (path || "").split(/[\\/]/).pop().split(".").pop().toLowerCase();
  const lang = path && LANGS.find((l) => l.exts.includes(ext));
  return lang ? { name: lang.name, support: lang.load() } : { name: "Plain text", support: [] };
}
