// Safe, deliberately small Markdown renderer for text announcements (Preact + htm).
// Supported: paragraphs with visible line breaks, ATX headings (1–6), ordered/unordered lists
// with indented continuations, block quotes, rules, fenced code, inline code, strong/emphasis,
// backslash escapes, inline links/images (optionally with a quoted title), bare HTTP(S) URLs and <HTTP(S)> links.
// This is not full CommonMark: tables, reference links/images, other autolinks and HTML stay text.
// Source never becomes HTML; only the fixed elements below are created as Preact vnodes.
// Images use only the private announcement-assets route, with no referrer and at most 32 per document.
// CSS: .announcement-markdown, __code (scrollable pre), __inline-code, __image and __notice.

import { html, h } from './components.js';
import { ANNOUNCEMENT_MAX_BODY_CHARS } from '../../../shared/announcements.js';
import { ANNOUNCEMENT_ASSET_URL_PREFIX, announcementAssetSegments, announcementAssetMime } from '../../../shared/announcementAssets.js';
import { t } from '../../../shared/i18n.js';

export const ANNOUNCEMENT_MARKDOWN_LIMITS = Object.freeze({ chars: ANNOUNCEMENT_MAX_BODY_CHARS, nodes: 6000, depth: 8, images: 32 });

/** Safe browser destination, or null. Protocol-relative URLs and encoded scheme tricks are rejected. */
export function safeAnnouncementHref(value) {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href || /[\s\u0000-\u001f\u007f-\u009f\\<>]/u.test(href)) return null;
  if (/&(?:#\d+|#x[\da-f]+|colon|tab|newline);/i.test(href)) return null;
  // Reject a percent-encoded scheme as well, although browsers treat it as a relative path.
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  if (/^[^/?#]*%/.test(href) && /^[^/?#]*[:\\]/.test(decoded)) return null;
  if (href.startsWith('//')) return null;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href);
  if (scheme && !/^(?:https?|mailto)$/i.test(scheme[1])) return null;
  if (scheme && /^https?$/i.test(scheme[1]) && !/^https?:\/\/[^/]/i.test(href)) return null;
  if (scheme && /^mailto$/i.test(scheme[1]) && !/^mailto:[^?#]+/i.test(href)) return null;
  try {
    const url = new URL(href, 'https://announcement.invalid/');
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return href;
  } catch { return null; }
}

/** Only announcement assets are images; all three documented forms become the dedicated read-only API URL. */
export function safeAnnouncementImageSrc(value) {
  if (typeof value !== 'string') return null;
  const src = value.trim();
  const prefix = [ANNOUNCEMENT_ASSET_URL_PREFIX, 'assets/', './assets/'].find((entry) => src.startsWith(entry));
  if (!prefix) return null;
  const segments = announcementAssetSegments(src.slice(prefix.length));
  if (!segments || !announcementAssetMime(segments[segments.length - 1])) return null;
  try { return ANNOUNCEMENT_ASSET_URL_PREFIX + segments.map(encodeURIComponent).join('/'); }
  catch { return null; } // malformed UTF-16 in untrusted Markdown must remain text, never throw
}

function budget() {
  return {
    used: 0, images: 0, truncated: false,
    take() {
      if (this.used >= ANNOUNCEMENT_MARKDOWN_LIMITS.nodes) { this.truncated = true; return false; }
      this.used += 1;
      return true;
    },
  };
}

// Index matched punctuation once. Repeated unmatched '[' or '`' never trigger repeated suffix scans.
function inlineIndexes(source) {
  const ticks = [], nextTick = new Map(), lastTick = new Map();
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] !== '`') continue;
    const at = i;
    while (source[i + 1] === '`') i++;
    ticks.push({ at, width: i - at + 1 });
  }
  for (let i = ticks.length - 1; i >= 0; i--) {
    const { at, width } = ticks[i];
    if (lastTick.has(width)) nextTick.set(at, { end: lastTick.get(width), width });
    lastTick.set(width, at);
  }
  const brackets = [], parens = [], closing = new Map();
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    const code = nextTick.get(i);
    if (code) { i = code.end + code.width - 1; continue; }
    const char = source[i];
    if (char === '[') brackets.push(i);
    else if (char === ']' && brackets.length) closing.set(brackets.pop(), i);
    else if (char === '(') parens.push(i);
    else if (char === ')' && parens.length) closing.set(parens.pop(), i);
  }
  // Keep source HTML readable as text, including Markdown inside paired tags. No HTML parser/DOM is used.
  const htmlEnd = new Map(), tags = [];
  let lineEnd = source.indexOf('\n');
  if (lineEnd < 0) lineEnd = source.length;
  for (const tag of source.matchAll(/<(\/?)([a-z][\w:-]*)(?=[ \t/>])[^<>\n]*>/gi)) {
    if (/^<https?:\/\//i.test(tag[0])) continue; // angle autolinks are not opening HTML elements
    while (tag.index >= lineEnd && lineEnd < source.length) {
      const next = source.indexOf('\n', lineEnd + 1);
      lineEnd = next < 0 ? source.length : next;
    }
    const name = tag[2].toLowerCase(), end = tag.index + tag[0].length;
    htmlEnd.set(tag.index, end);
    if (tag[1]) {
      const opened = tags[tags.length - 1];
      if (opened?.name === name) { htmlEnd.set(opened.at, end); tags.pop(); }
    } else if (!/\/\s*>$/.test(tag[0]) && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) {
      // An incomplete HTML element keeps the remainder of its line literal too.
      htmlEnd.set(tag.index, lineEnd);
      tags.push({ name, at: tag.index });
    }
  }
  return { nextTick, closing, htmlEnd };
}

function destination(raw, image = false) {
  const match = /^(?:<([^<>\n]+)>|([^\s]+?))(?:[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'))?$/.exec(raw.trim());
  if (!match) return null;
  const href = (image ? safeAnnouncementImageSrc : safeAnnouncementHref)(match[1] ?? match[2]);
  return href ? { href, title: match[3] ?? match[4] } : null;
}

function inlinePlain(nodes) {
  return nodes.map((node) => node.type === 'break' ? ' ' : node.text ?? inlinePlain(node.children || [])).join('');
}

// Read each candidate once, including rejected destinations; never retry inner URL-shaped substrings.
function bareUrlAt(source, at) {
  if (!/^https?:\/\//i.test(source.slice(at, at + 8))
    || /[a-z\d_@/\\:.%<\-]/i.test(source[at - 1] || '')) return null;
  let end = at;
  const opens = { '(': 0, '[': 0, '{': 0 }, pairs = { ')': '(', ']': '[', '}': '{' };
  const unmatched = new Set();
  while (end < source.length && !/[\s\u0000-\u001f\u007f-\u009f<>`"'*，。；：！？、…“”‘’「」『』《》（）【】]/u.test(source[end])) {
    const char = source[end];
    if (char in opens) opens[char]++;
    else if (char in pairs) {
      if (opens[pairs[char]]) opens[pairs[char]]--;
      else unmatched.add(end);
    }
    end++;
  }
  let urlEnd = end;
  while (urlEnd > at && (/[.,;:!?]/.test(source[urlEnd - 1]) || unmatched.has(urlEnd - 1))) urlEnd--;
  const href = safeAnnouncementHref(source.slice(at, urlEnd));
  return { end, urlEnd, href };
}

function parseInline(source, state, allowLinks = true, allowImages = true) {
  const { nextTick, closing, htmlEnd } = inlineIndexes(source);
  const frames = [{ children: [] }];
  const current = () => frames[frames.length - 1].children;
  const appendText = (text) => {
    if (!text) return true;
    const children = current(), last = children[children.length - 1];
    if (last?.type === 'text') { last.text += text; return true; }
    if (!state.take()) return false;
    children.push({ type: 'text', text });
    return true;
  };
  const append = (node) => {
    if (!state.take()) return false;
    current().push(node);
    return true;
  };
  const appendLiteral = (text) => {
    const lines = text.split('\n');
    for (let line = 0; line < lines.length && !state.truncated; line++) {
      if (line > 0) append({ type: 'break' });
      appendText(lines[line]);
    }
  };
  const appendAutoLink = (href) => {
    if (!state.take()) return;
    append({ type: 'link', href, children: [{ type: 'text', text: href }] });
  };
  for (let i = 0; i < source.length && !state.truncated;) {
    const char = source[i];
    if (char === '\\' && (/[\\`*{}[\]()#+\-.!_<>~|]/.test(source[i + 1] || '')
      || (!allowImages && /["']/.test(source[i + 1] || '')))) {
      appendText(source[i + 1]); i += 2; continue;
    }
    if (char === '\n') { append({ type: 'break' }); i++; continue; }
    const code = nextTick.get(i);
    if (code) {
      let text = source.slice(i + code.width, code.end).replace(/\n/g, ' ');
      if (text.startsWith(' ') && text.endsWith(' ') && /\S/.test(text)) text = text.slice(1, -1);
      append({ type: 'code', text }); i = code.end + code.width; continue;
    }
    if (char === '<' && /^<https?:\/\//i.test(source.slice(i, i + 9))) {
      const close = source.indexOf('>', i + 1), lineEnd = source.indexOf('\n', i + 1);
      if (close < 0 || (lineEnd >= 0 && lineEnd < close)) {
        const end = lineEnd < 0 ? source.length : lineEnd;
        appendLiteral(source.slice(i, end)); i = end; continue;
      }
      const raw = source.slice(i + 1, close);
      const href = allowLinks && raw === raw.trim() ? safeAnnouncementHref(raw) : null;
      if (href) appendAutoLink(href);
      else appendLiteral(source.slice(i, close + 1));
      i = close + 1; continue;
    }
    const endHtml = htmlEnd.get(i);
    if (endHtml != null) {
      appendLiteral(source.slice(i, endHtml));
      i = endHtml; continue;
    }
    const image = char === '!' && source[i + 1] === '[';
    const open = image ? i + 1 : i;
    if (image || (char === '[' && allowLinks)) {
      const endLabel = closing.get(open);
      if (endLabel != null) {
        const suffix = source[endLabel + 1];
        const end = (suffix === '(' || suffix === '[') ? closing.get(endLabel + 1) : null;
        if (end != null) {
          const target = suffix === '(' && (!image || allowImages) ? destination(source.slice(endLabel + 2, end), image) : null;
          if (target) {
            if (image) {
              if (state.images >= ANNOUNCEMENT_MARKDOWN_LIMITS.images) { state.truncated = true; break; }
              const alt = inlinePlain(parseInline(source.slice(open + 1, endLabel), state, false, false));
              if (append({ type: 'image', src: target.href, title: target.title, alt })) state.images++;
            } else {
              const children = parseInline(source.slice(open + 1, endLabel), state, false);
              append({ type: 'link', ...target, children });
            }
          } else appendLiteral(source.slice(i, end + 1));
          i = end + 1; continue;
        }
        if (image || suffix === '(' || suffix === '[') {
          const lineEnd = source.indexOf('\n', endLabel + 1);
          const literalEnd = suffix === '(' || suffix === '[' ? (lineEnd < 0 ? source.length : lineEnd) : endLabel + 1;
          appendLiteral(source.slice(i, literalEnd)); i = literalEnd; continue;
        }
      } else {
        const lineEnd = source.indexOf('\n', i);
        const literalEnd = lineEnd < 0 ? source.length : lineEnd;
        appendLiteral(source.slice(i, literalEnd)); i = literalEnd; continue;
      }
    }
    if (allowLinks && (char === 'h' || char === 'H')) {
      const url = bareUrlAt(source, i);
      if (url) {
        if (url.href) {
          appendAutoLink(url.href);
          appendText(source.slice(url.urlEnd, url.end));
        } else appendLiteral(source.slice(i, url.end));
        i = url.end; continue;
      }
    }
    if (char === '*' || char === '_') {
      let end = i + 1;
      while (source[end] === char) end++;
      let count = end - i;
      const left = source[i - 1] || '', right = source[end] || '';
      const word = (s) => /[\p{L}\p{N}]/u.test(s);
      const inWord = char === '_' && word(left) && word(right);
      const canClose = !!left && !/\s/.test(left) && !inWord;
      const canOpen = !!right && !/\s/.test(right) && !inWord;
      while (canClose && frames.length > 1) {
        const frame = frames[frames.length - 1];
        if (frame.marker[0] !== char || count < frame.marker.length) break;
        frames.pop();
        count -= frame.marker.length;
        current().push({ type: frame.marker.length === 2 ? 'strong' : 'em', children: frame.children });
      }
      while (canOpen && count > 0 && frames.length <= ANNOUNCEMENT_MARKDOWN_LIMITS.depth && !state.truncated) {
        const width = count >= 2 ? 2 : 1;
        if (!state.take()) break;
        frames.push({ marker: char.repeat(width), children: [] });
        count -= width;
      }
      appendText(char.repeat(count)); i = end; continue;
    }
    appendText(char); i++;
  }
  // Unclosed emphasis remains readable, including any properly closed inner formatting.
  while (frames.length > 1) {
    const frame = frames.pop();
    current().push({ type: 'text', text: frame.marker }, ...frame.children);
  }
  return frames[0].children;
}

const fenceOf = (line) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const headingOf = (line) => /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
const quoteOf = (line) => /^ {0,3}>[ \t]?(.*)$/.exec(line);
const listOf = (line) => {
  const match = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line);
  return match ? { indent: match[1].length, ordered: /^\d/.test(match[2]), start: parseInt(match[2], 10),
    content: match[4], continuation: match[1].length + match[2].length + match[3].length } : null;
};
const ruleOf = (line) => {
  if (/^ {4}/.test(line)) return false;
  const text = line.replace(/[ \t]/g, '');
  return text.length >= 3 && /^(?:\*+|-+|_+)$/.test(text);
};
const startsBlock = (line) => !!(fenceOf(line) || headingOf(line) || quoteOf(line) || listOf(line) || ruleOf(line));

function parseBlocks(lines, state, depth = 0) {
  const blocks = [];
  for (let i = 0; i < lines.length && !state.truncated;) {
    if (!lines[i].trim()) { i++; continue; }
    if (!state.take()) break;
    const line = lines[i], fence = fenceOf(line), heading = headingOf(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const body = [], marker = fence[1];
      i++;
      while (i < lines.length) {
        const close = fenceOf(lines[i]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length && !close[2].trim()) { i++; break; }
        body.push(lines[i++]);
      }
      const language = fence[2].trim().split(/\s/)[0];
      blocks.push({ type: 'codeBlock', text: body.join('\n'), language: /^[\w-]{1,32}$/.test(language) ? language : '' });
      continue;
    }
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length,
        children: parseInline((heading[2] || '').replace(/[ \t]+#+[ \t]*$/, ''), state) });
      i++; continue;
    }
    if (ruleOf(line)) { blocks.push({ type: 'rule' }); i++; continue; }
    if (depth < ANNOUNCEMENT_MARKDOWN_LIMITS.depth && quoteOf(line)) {
      const quoted = [];
      while (i < lines.length) {
        const quote = quoteOf(lines[i]);
        if (!quote) break;
        quoted.push(quote[1]); i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted, state, depth + 1) });
      continue;
    }
    const first = listOf(line);
    if (depth < ANNOUNCEMENT_MARKDOWN_LIMITS.depth && first) {
      const items = [];
      while (i < lines.length && !state.truncated) {
        const item = listOf(lines[i]);
        if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;
        const body = [item.content];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next = i + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            const nextItem = listOf(lines[next] || '');
            if (nextItem && nextItem.indent === first.indent && nextItem.ordered === first.ordered) { i = next; break; }
            if (lines[next]?.startsWith(' '.repeat(item.continuation))) { body.push(''); i = next; continue; }
            break;
          }
          if (lines[i].startsWith(' '.repeat(item.continuation))) {
            body.push(lines[i].slice(item.continuation)); i++; continue;
          }
          if (startsBlock(lines[i])) break;
          body.push(lines[i++]);
        }
        if (!state.take()) break;
        items.push(parseBlocks(body, state, depth + 1));
      }
      blocks.push({ type: 'list', ordered: first.ordered, start: first.ordered ? first.start : undefined, items });
      continue;
    }
    const body = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) body.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n'), state) });
  }
  return blocks;
}

/** Pure parser. Invalid/non-string input is empty; truncation is explicit in the returned metadata. */
export function parseAnnouncementMarkdown(source) {
  const state = budget();
  if (typeof source !== 'string') return { blocks: [], truncated: false };
  let bounded = source.slice(0, ANNOUNCEMENT_MARKDOWN_LIMITS.chars);
  const lengthTruncated = bounded.length < source.length;
  // Do not split an emoji's UTF-16 surrogate pair at the length boundary.
  if (lengthTruncated && /[\ud800-\udbff]$/.test(bounded)) bounded = bounded.slice(0, -1);
  const blocks = parseBlocks(bounded.replace(/\r\n?/g, '\n').split('\n'), state);
  return { blocks, truncated: lengthTruncated || state.truncated };
}

function renderInline(nodes) {
  return nodes.map((node) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'break') return html`<br />`;
    if (node.type === 'code') return html`<code class="announcement-markdown__inline-code">${node.text}</code>`;
    if (node.type === 'strong') return html`<strong>${renderInline(node.children)}</strong>`;
    if (node.type === 'em') return html`<em>${renderInline(node.children)}</em>`;
    if (node.type === 'image') return html`<img class="announcement-markdown__image" src=${node.src} alt=${node.alt}
      title=${node.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />`;
    if (node.type === 'link') {
      const external = /^https?:\/\//i.test(node.href);
      return html`<a href=${node.href} title=${node.title} target=${external ? '_blank' : undefined}
        rel=${external ? 'noopener noreferrer' : undefined}>${renderInline(node.children)}</a>`;
    }
    return null;
  });
}

function renderBlocks(blocks) {
  return blocks.map((block) => {
    if (block.type === 'paragraph') return html`<p>${renderInline(block.children)}</p>`;
    if (block.type === 'heading') return h(`h${block.level}`, null, renderInline(block.children));
    if (block.type === 'rule') return html`<hr />`;
    if (block.type === 'codeBlock') return html`<pre class="announcement-markdown__code"><code data-language=${block.language || undefined}>${block.text}</code></pre>`;
    if (block.type === 'quote') return html`<blockquote>${renderBlocks(block.blocks)}</blockquote>`;
    if (block.type === 'list') {
      const items = block.items.map((blocks) => html`<li>${blocks.length === 1 && blocks[0].type === 'paragraph'
        ? renderInline(blocks[0].children) : renderBlocks(blocks)}</li>`);
      return block.ordered ? html`<ol start=${block.start}>${items}</ol>` : html`<ul>${items}</ul>`;
    }
    return null;
  });
}

/** Render only trusted element names, with source text escaped by Preact. */
export function AnnouncementMarkdown({ source }) {
  const { blocks, truncated } = parseAnnouncementMarkdown(source);
  return html`<div class="announcement-markdown">${renderBlocks(blocks)}
    ${truncated ? html`<p class="announcement-markdown__notice">${t('公告内容过长，已截断显示。')}</p>` : null}
  </div>`;
}
