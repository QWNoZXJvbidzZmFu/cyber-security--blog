/* global hexo */
'use strict';

/**
 * Obsidian-flavoured Markdown support for Hexo.
 *
 * Supported syntax
 *   ==highlight==                 -> <mark class="obsidian-highlight">
 *   %%comment%%                   -> removed (inline or multi-line)
 *   > [!note] Title / body        -> styled callout, supports + (open) / - (collapsed)
 *   [[Post title]]                -> link to a post whose title / slug / filename matches
 *   [[Post title|alias]]          -> same, custom text
 *   [[Post title#Heading]]        -> link with an anchor
 *   ![[image.png]]                -> image from source/图片 (publish.sh copies them)
 *   ![[image.png|300]]            -> image with a width
 *   - [ ] task / - [x] done       -> disabled checkbox
 *
 * Code blocks, inline code and raw HTML are left untouched.
 */

const fs = require('fs');
const path = require('path');

let urlFor = null;
let encodeURL = null;
let slugize = null;
try {
  const util = require('hexo-util');
  urlFor = util.url_for;
  encodeURL = util.encodeURL;
  slugize = util.slugize;
} catch (err) {
  // hexo-util is always present in a normal Hexo install; the fallbacks below
  // keep the plugin usable if it is not.
}

const CALLOUT_TYPES = {
  note: { icon: '📝', title: 'Note' },
  abstract: { icon: '📌', title: 'Abstract' },
  summary: { icon: '📌', title: 'Summary' },
  tldr: { icon: '📌', title: 'TL;DR' },
  info: { icon: 'ℹ️', title: 'Info' },
  todo: { icon: '☑️', title: 'Todo' },
  tip: { icon: '💡', title: 'Tip' },
  hint: { icon: '💡', title: 'Hint' },
  important: { icon: '❗', title: 'Important' },
  success: { icon: '✅', title: 'Success' },
  check: { icon: '✅', title: 'Check' },
  done: { icon: '✅', title: 'Done' },
  question: { icon: '❓', title: 'Question' },
  help: { icon: '❓', title: 'Help' },
  faq: { icon: '❓', title: 'FAQ' },
  warning: { icon: '⚠️', title: 'Warning' },
  caution: { icon: '⚠️', title: 'Caution' },
  attention: { icon: '⚠️', title: 'Attention' },
  failure: { icon: '❌', title: 'Failure' },
  fail: { icon: '❌', title: 'Fail' },
  missing: { icon: '❌', title: 'Missing' },
  danger: { icon: '🔥', title: 'Danger' },
  error: { icon: '🔥', title: 'Error' },
  bug: { icon: '🐛', title: 'Bug' },
  example: { icon: '📋', title: 'Example' },
  quote: { icon: '💬', title: 'Quote' },
  cite: { icon: '💬', title: 'Cite' }
};

const HIGHLIGHT_RE = /(?<![=\\])==(?!=)(?=\S)([^\n]*?[^\s=])==(?!=)/g;
const COMMENT_RE = /%%[\s\S]*?%%/g;
const WIKILINK_RE = /!?\[\[([^\[\]\n]+?)\]\]/g;
const HTML_TAG_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, ' ');
}

function siteUrl(hexo, target) {
  if (urlFor) {
    try {
      return urlFor.call(hexo, target);
    } catch (err) {
      // Fall back to a simple root prefix if the site URL is not configured.
    }
  }
  const root = (hexo.config.root || '/').replace(/\/$/, '');
  return root + (target.startsWith('/') ? target : '/' + target);
}

function encodeLink(hexo, target) {
  try {
    const url = siteUrl(hexo, target);
    return encodeURL ? encodeURL(url) : url;
  } catch (err) {
    return target;
  }
}

function headingId(heading) {
  if (!heading) return '';
  return slugize ? slugize(heading) : heading;
}

/** Replace matched text with opaque tokens so later passes can skip it. */
function createMasker() {
  const store = [];
  return {
    hold(text) {
      const token = `\u0000OBS${store.length}\u0000`;
      store.push(text);
      return token;
    },
    restore(text) {
      return text.replace(/\u0000OBS(\d+)\u0000/g, (match, index) => {
        const value = store[Number(index)];
        return value === undefined ? match : value;
      });
    }
  };
}

function fenceStart(line) {
  const match = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/.exec(line);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

function fenceEnd(line, fence) {
  const re = new RegExp(`^[ \\t]*(?:>[ \\t]*)*\\${fence.char}{${fence.length},}[ \\t]*$`);
  return re.test(line);
}

/**
 * Turn Obsidian callout blockquotes into raw HTML blocks. Markdown inside the
 * callout is still rendered because the body is separated from the wrapper by
 * blank lines (CommonMark HTML block type 6).
 */
function convertCallouts(text) {
  const lines = text.split('\n');
  const out = [];
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      out.push(line);
      if (fenceEnd(line, fence)) fence = null;
      continue;
    }

    const openingFence = fenceStart(line);
    if (openingFence) {
      fence = openingFence;
      out.push(line);
      continue;
    }

    const match = /^([ \t]*)((?:>[ \t]*)+)\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }

    const indent = match[1];
    const depth = (match[2].match(/>/g) || []).length;
    const type = match[3].toLowerCase();
    const fold = match[4];
    const customTitle = match[5].trim();
    const bodyRe = new RegExp(`^[ \\t]*(?:>[ \\t]?){${depth}}(.*)$`);
    const body = [];

    let j = i + 1;
    for (; j < lines.length; j++) {
      const bodyMatch = bodyRe.exec(lines[j]);
      if (!bodyMatch) break;
      body.push(bodyMatch[1]);
    }

    out.push(buildCallout({ indent, type, fold, customTitle, body }));
    i = j - 1;
  }

  return out.join('\n');
}

function buildCallout({ indent, type, fold, customTitle, body }) {
  const meta = CALLOUT_TYPES[type] || { icon: '📘', title: type, color: '#448aff' };
  const classes = `obsidian-callout obsidian-callout-${type}`;
  const title = customTitle || meta.title;
  const titleHtml =
    `<span class="obsidian-callout-icon" aria-hidden="true">${meta.icon}</span>` +
    `<span class="obsidian-callout-title-text">${escapeHtml(title)}</span>`;

  // One quote level was removed from the body, so nested callouts are just
  // regular callouts again inside this text.
  const inner = convertCallouts(body.join('\n'));

  if (fold) {
    const open = fold === '+' ? ' open' : '';
    return [
      `${indent}<details class="${classes}"${open}>`,
      `${indent}<summary class="obsidian-callout-title">${titleHtml}</summary>`,
      '',
      inner,
      '',
      `${indent}</details>`
    ].join('\n');
  }

  return [
    `${indent}<div class="${classes}">`,
    `${indent}<div class="obsidian-callout-title">${titleHtml}</div>`,
    '',
    inner,
    '',
    `${indent}</div>`
  ].join('\n');
}

function buildPostIndex(hexo) {
  let posts;
  try {
    posts = hexo.locals.get('posts');
  } catch (err) {
    return null;
  }
  if (!posts) return null;

  const list = typeof posts.toArray === 'function' ? posts.toArray() : Array.from(posts);
  const index = new Map();

  for (const post of list) {
    if (!post || !post.path) continue;
    const keys = [
      post.slug,
      post.title,
      post.source ? path.basename(post.source, path.extname(post.source)) : ''
    ];
    for (const key of keys) {
      if (!key) continue;
      const normalized = String(key).trim().toLowerCase();
      if (!index.has(normalized)) index.set(normalized, post);
    }
  }

  return index;
}

function resolvePost(index, target) {
  if (!index) return null;
  const needle = target
    .replace(/\.md$/i, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim();
  return index.get(needle.toLowerCase()) || null;
}

function resolveImage(hexo, target) {
  const clean = target.replace(/^\/+/, '').replace(/^\.\//, '');
  const relative = clean.startsWith('图片/') ? clean : `图片/${clean}`;
  try {
    const abs = path.join(hexo.source_dir, relative);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return relative;
  } catch (err) {
    // Ignore unreadable paths and render the missing-image placeholder.
  }
  return null;
}

function renderWikilink(hexo, index, inner, isEmbed) {
  const parts = inner.split('|');
  const rawTarget = parts[0].trim();
  const second = (parts[1] || '').trim();

  const hashIndex = rawTarget.indexOf('#');
  const target = (hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex)).trim();
  const heading = hashIndex === -1 ? '' : rawTarget.slice(hashIndex + 1).trim();
  const display = second || (target ? target.split('/').pop().replace(/\.md$/i, '') : heading) || rawTarget;

  if (isEmbed) {
    const imagePath = resolveImage(hexo, target);
    const alt = second && !/^\d+$/.test(second) ? second : target.split('/').pop().replace(/\.[^.]+$/, '');
    if (imagePath) {
      const src = encodeLink(hexo, '/' + imagePath);
      const width = /^\d+$/.test(second) ? ` width="${second}"` : '';
      return `<img class="obsidian-embed" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${width} loading="lazy">`;
    }
    return `<span class="obsidian-embed-missing" title="图片不存在：${escapeAttr(target)}">![[${escapeHtml(inner)}]]</span>`;
  }

  if (!target) {
    return `<a class="obsidian-wikilink" href="#${escapeAttr(encodeURIComponent(headingId(heading)))}">${escapeHtml(display)}</a>`;
  }

  const post = resolvePost(index, target);
  if (!post) {
    return `<span class="obsidian-wikilink is-missing" title="没有找到笔记：${escapeAttr(target)}">${escapeHtml(display)}</span>`;
  }

  let href = encodeLink(hexo, post.path);
  if (heading) href += `#${encodeURIComponent(headingId(heading))}`;
  return `<a class="obsidian-wikilink" href="${escapeAttr(href)}" title="${escapeAttr(post.title || display)}">${escapeHtml(display)}</a>`;
}

function transformMarkdown(source, hexo) {
  if (typeof source !== 'string' || source.length === 0) return source;

  const masker = createMasker();
  let text = convertCallouts(source);

  // Fenced and indented code blocks (including ones unquoted from callouts).
  text = maskCodeBlocks(text, masker);

  // Inline code spans.
  text = maskInlineCode(text, masker);

  // Raw HTML (including the callout wrappers we just generated) must survive.
  text = text.replace(HTML_TAG_RE, match => masker.hold(match));

  // %%comments%% (inline and multi-line).
  text = text.replace(COMMENT_RE, '');

  // Task lists.
  text = text.replace(
    /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\][ \t]+/gm,
    (match, prefix, state) =>
      `${prefix}<input type="checkbox" class="obsidian-task-checkbox" disabled${state.toLowerCase() === 'x' ? ' checked' : ''}> `
  );

  // [[wikilinks]] and ![[embeds]]
  const postIndex = buildPostIndex(hexo);
  text = text.replace(WIKILINK_RE, (match, inner) =>
    masker.hold(renderWikilink(hexo, postIndex, inner, match.startsWith('!')))
  );

  // Protect the tags generated above (their attributes may contain == too).
  text = text.replace(HTML_TAG_RE, match => masker.hold(match));

  // ==highlight==
  text = text.replace(HIGHLIGHT_RE, '<mark class="obsidian-highlight">$1</mark>');

  return masker.restore(text);
}

function maskCodeBlocks(text, masker) {
  const lines = text.split('\n');
  const out = [];
  let fence = null;
  let inIndented = false;
  let previousBlank = true;

  for (const line of lines) {
    if (fence) {
      const closed = fenceEnd(line, fence);
      out.push(masker.hold(line));
      if (closed) fence = null;
      continue;
    }

    if (inIndented) {
      if (line.trim() === '') {
        out.push(line);
        previousBlank = true;
        continue;
      }
      if (/^(?: {4}|\t)/.test(line)) {
        out.push(masker.hold(line));
        previousBlank = false;
        continue;
      }
      inIndented = false;
    }

    if (line.trim() === '') {
      out.push(line);
      previousBlank = true;
      continue;
    }

    const start = fenceStart(line);
    if (start) {
      fence = start;
      out.push(masker.hold(line));
      previousBlank = false;
      continue;
    }

    // A tab/four-space line is an indented code block only when it starts a
    // block (at the beginning of the document or after a blank line). This
    // keeps a tab-indented continuation line of a paragraph untouched.
    if (previousBlank && /^(?: {4}|\t)/.test(line)) {
      inIndented = true;
      out.push(masker.hold(line));
      previousBlank = false;
      continue;
    }

    out.push(line);
    previousBlank = false;
  }

  return out.join('\n');
}

function maskInlineCode(text, masker) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '`') {
      const next = text.indexOf('`', i);
      const end = next === -1 ? text.length : next;
      out += text.slice(i, end);
      i = end;
      continue;
    }

    let j = i;
    while (text[j] === '`') j++;
    const run = text.slice(i, j);

    let close = text.indexOf(run, j);
    while (close !== -1 && text[close + run.length] === '`') {
      let end = close;
      while (text[end] === '`') end++;
      close = text.indexOf(run, end);
    }

    if (close === -1) {
      out += run;
      i = j;
      continue;
    }

    const end = close + run.length;
    out += masker.hold(text.slice(i, end));
    i = end;
  }

  return out;
}

hexo.extend.filter.register('before_post_render', function (data) {
  if (!data || typeof data.content !== 'string') return data;
  data.content = transformMarkdown(data.content, this || hexo);
  return data;
}, 1);

// Add the stylesheet to every rendered page. Kept as a filter so that no theme
// configuration has to be touched and the site root is respected.
hexo.extend.filter.register('after_render:html', function (html) {
  if (typeof html !== 'string' || !html.includes('</head>')) return html;
  const css = escapeAttr(encodeLink(hexo, '/样式/obsidian.css'));
  const tag = `<link rel="stylesheet" href="${css}">`;
  if (html.includes(tag)) return html;
  return html.replace('</head>', `${tag}\n</head>`);
});

// Exported for tests / reuse.
module.exports = { transformMarkdown };
