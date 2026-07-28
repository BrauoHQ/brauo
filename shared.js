// Brauo shared constants and helpers, loaded by the service worker, the content script, and the options page.
const BRAUO_CLOUD_API = "https://api.brauo.com";
// Names this client to the API so usage can be split by product. It is a
// plain analytics label: the service treats it as a hint and never as
// permission, and it carries nothing about the page or the user.
const BRAUO_CLIENT_HEADER = "X-Brauo-Client";
const BRAUO_CLIENT_NAME = "extension";
const BRAUO_PREVIEW_SAMPLE = "This is how I sound.";
const BRAUO_MAX_CHARS = 1800; // the service rejects requests near 2000 chars

// Default voice for a new user: one of Brauo's own (self-hosted, free) voices in
// the user's browser language. es -> Elena, pt -> Bia, otherwise Milo (English).
function brauoDefaultVoice() {
  const lang = ((typeof navigator !== "undefined" && navigator.language) || "en").slice(0, 2).toLowerCase();
  if (lang === "es") return "brauo-elena-es";
  if (lang === "pt") return "brauo-bia-pt";
  return "brauo-milo-en";
}

function brauoNormalizeConfig(sync, local) {
  return {
    speed: sync.speed || "1",
    cloud: {
      apiKey: local.cloudApiKey || "",
      voice: (sync.cloud && sync.cloud.voice) || brauoDefaultVoice(),
      baseUrl: local.cloudBaseUrl || BRAUO_CLOUD_API
    }
  };
}

function brauoLangLabel(lang) {
  try {
    const base = (lang || "").split("-")[0];
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    const name = dn.of(base) || lang;
    const region = lang.includes("-") ? ` (${lang.split("-")[1]})` : "";
    return name.charAt(0).toUpperCase() + name.slice(1) + region;
  } catch (_) { return lang; }
}

function brauoRenderVoiceOptions(sel, voiceList, selected, opts) {
  const groups = new Map();
  for (const v of voiceList) {
    const key = brauoLangLabel(v.lang);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  sel.innerHTML = "";
  for (const [label, voices] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const og = document.createElement("optgroup");
    og.label = label;
    for (const v of voices.sort((a, b) => a.name.localeCompare(b.name))) {
      const opt = document.createElement("option");
      opt.value = v.model;
      const label = opts && opts.withAccent && v.accent ? `${v.name} - ${v.accent}` : v.name;
      opt.textContent = v.badge ? `${label} · ${v.badge}` : label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (selected && ![...sel.options].some((o) => o.value === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = selected;
    sel.appendChild(opt);
  }
  if (selected) sel.value = selected;
}

function brauoVoicesForPlan(voices, plan) {
  if (String(plan || "").toLowerCase() === "free") {
    return voices.filter((v) => v.tier === "free");
  }
  return voices;
}

function brauoResolveVoiceForPlan(voices, plan, selected) {
  if (String(plan || "").toLowerCase() !== "free") return selected;
  const allowed = brauoVoicesForPlan(voices, plan);
  if (allowed.some((v) => v.model === selected)) return selected;
  if (!allowed.length) return selected;
  // Snap to a free voice, preferring the current voice's language so a Spanish
  // reader is not moved to another language just because it was first in the list.
  const base = (lang) => String(lang || "").split("-")[0].toLowerCase();
  const current = voices.find((v) => v.model === selected);
  const sameLang = current && allowed.find((v) => base(v.lang) === base(current.lang));
  return (sameLang || allowed[0]).model;
}

// Sentence-mode helpers for slow voices (time-to-first-audio).
// Boundaries match content.js chunkText: cut at ". " when present.
const BRAUO_SLOW_VOICE_TTL_MS = 24 * 60 * 60 * 1000;

function brauoSentencePieces(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];

  const sentences = [];
  let rest = t;
  while (rest.length) {
    const cut = rest.indexOf(". ");
    if (cut < 0) {
      if (rest.trim()) sentences.push(rest.trim());
      break;
    }
    const s = rest.slice(0, cut + 1).trim();
    if (s) sentences.push(s);
    rest = rest.slice(cut + 1).replace(/^\s+/, "");
  }
  if (!sentences.length) return [];

  const pieces = [];
  let first = sentences.shift();
  // First piece = first sentence alone; hard-split at 200 chars if longer.
  if (first.length > 200) {
    pieces.push(first.slice(0, 200).trim());
    const rem = first.slice(200).trim();
    if (rem) sentences.unshift(rem);
  } else {
    pieces.push(first);
  }

  // Remaining sentences merge greedily up to 250 chars per piece.
  let buf = "";
  for (const s of sentences) {
    if (!buf) {
      buf = s;
      continue;
    }
    const joined = buf + " " + s;
    if (joined.length <= 250) {
      buf = joined;
    } else {
      pieces.push(buf);
      buf = s;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function brauoIsVoiceSlow(slowVoices, voiceId, nowMs) {
  if (!slowVoices || !voiceId) return false;
  const markedAt = slowVoices[voiceId];
  if (markedAt == null || typeof markedAt !== "number") return false;
  return nowMs - markedAt < BRAUO_SLOW_VOICE_TTL_MS;
}

function brauoMarkVoiceSlow(slowVoices, voiceId, nowMs) {
  const next = Object.assign({}, slowVoices || {});
  if (voiceId) next[voiceId] = nowMs;
  return next;
}

// Speakable-text cleaning: delete noise / join fragments only — never rewrite words.
function brauoCleanText(text) {
  let t = String(text || "");
  // Soft hyphen, zero-width space/joiner/non-joiner, BOM.
  t = t.replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/\u00A0/g, " ");
  // Common Latin ligatures → ASCII letter pairs.
  t = t.replace(/\uFB00/g, "ff");
  t = t.replace(/\uFB01/g, "fi");
  t = t.replace(/\uFB02/g, "fl");
  t = t.replace(/\uFB03/g, "ffi");
  t = t.replace(/\uFB04/g, "ffl");
  // Wikipedia-style bracket noise: [23], [note 1], [citation needed], [edit], [editar].
  t = t.replace(/\[\s*(?:\d{1,3}|note\s+\d{1,3}|citation needed|edit|editar)\s*\]/gi, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// True when the text shows ≥3 distinct Markdown marker kinds (raw .md smell test).
function brauoLooksLikeMarkdown(text) {
  const t = String(text || "");
  let kinds = 0;
  if (/^#{1,6}\s/m.test(t)) kinds++;
  if (/```/.test(t)) kinds++;
  if (/^[-*+]\s/m.test(t)) kinds++;
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) kinds++;
  if (/^\d+\.\s/m.test(t)) kinds++;
  if (/^>\s/m.test(t)) kinds++;
  return kinds >= 3;
}

// Strip Markdown structure for TTS; keep words, drop syntax. Line-local for emphasis.
function brauoStripMarkdown(text) {
  let t = String(text || "");
  // Fenced code blocks removed entirely (including fences).
  t = t.replace(/```[\s\S]*?```/g, "");

  const lines = t.split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    // Horizontal rules.
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue;

    // Headings: keep the title text.
    line = line.replace(/^#{1,6}\s+/, "");
    // Blockquotes: strip leading marker.
    line = line.replace(/^>\s?/, "");
    // Unordered / ordered list markers; keep item text.
    line = line.replace(/^[-*+]\s+/, "");
    line = line.replace(/^\d+\.\s+/, "");

    // Table rows: | a | b | → "a, b"
    const trimmed = line.trim();
    if (trimmed.includes("|") && /^\|.*\|$/.test(trimmed)) {
      let body = trimmed;
      if (body.startsWith("|")) body = body.slice(1);
      if (body.endsWith("|")) body = body.slice(0, -1);
      line = body.split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    }

    // Images gone; links keep label.
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

    // Paired emphasis on the same line only. Digit/word-adjacent * / _ stay (e.g. 2*3*4).
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    line = line.replace(/__([^_]+)__/g, "$1");
    line = line.replace(/(?<![*\w])\*([^*]+)\*(?!\w)/g, "$1");
    line = line.replace(/(?<![_\w])_([^_]+)_(?!\w)/g, "$1");

    // Inline code: keep inner text.
    line = line.replace(/`([^`]+)`/g, "$1");

    out.push(line);
  }
  return out.join("\n");
}
