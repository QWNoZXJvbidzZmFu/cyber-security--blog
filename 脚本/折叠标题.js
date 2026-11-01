/* Obsidian 风格的标题折叠
 *
 * 做法：把 #article-container 里扁平的兄弟节点按标题层级重新包成嵌套结构，
 *   <h3>标题</h3><p>…</p><h4>子标题</h4><p>…</p>
 * 变成
 *   <h3 class="fold-heading">[箭头]标题</h3>
 *   <div class="fold-body"><p>…</p>
 *     <h4 class="fold-heading">[箭头]子标题</h4>
 *     <div class="fold-body"><p>…</p></div>
 *   </div>
 * 这样折叠一个标题时，它下面所有更深层的内容会跟着一起收起，和 Obsidian 一致。
 *
 * 样式在 source/样式/折叠标题.css。
 */

(function () {
  'use strict';

  var CONTAINER_ID = 'article-container';
  var STORAGE_KEY = 'foldHeadings';
  var HEADING_TAG = /^H[1-6]$/;

  // 向下指的箭头，折叠时用 CSS 转成向右
  var CHEVRON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M3.6 5.9 8 10.3l4.4-4.4" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function isHeading(node) {
    return !!node && node.nodeType === 1 && HEADING_TAG.test(node.tagName);
  }

  /* ------------------------------ 本地存储 ------------------------------ */

  function readStore() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      return {};
    }
  }

  function writeStore(store) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (err) {
      // 隐私模式 / 存储配额满时静默失败，折叠功能本身不受影响
    }
  }

  function pageKey() {
    return window.location.pathname;
  }

  function remember(section, collapsed) {
    var id = section.heading.id;
    if (!id) return;
    var store = readStore();
    var key = pageKey();
    var entry = store[key] || {};
    if (collapsed) {
      entry[id] = 1;
    } else {
      delete entry[id];
    }
    if (Object.keys(entry).length) {
      store[key] = entry;
    } else {
      delete store[key];
    }
    writeStore(store);
  }

  /* ------------------------------ 建结构 ------------------------------ */

  /**
   * 按标题层级把正文包成嵌套的 .fold-body。
   * 只处理 #article-container 的直接子元素：写在 callout / tabs / note 里面的
   * 标题不算正文大纲的一部分，不给它们加箭头。
   */
  function buildSections(container) {
    var sections = [];
    var stack = [];
    // children 是 live 集合，先复制成静态数组，因为下面会移动节点
    var children = Array.prototype.slice.call(container.children);

    children.forEach(function (node) {
      if (!isHeading(node)) {
        var current = stack[stack.length - 1];
        if (current) current.body.appendChild(node);
        return;
      }

      var level = Number(node.tagName.charAt(1));
      // 遇到同级或更高级的标题，先把更深的层关掉
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();

      var parent = stack.length ? stack[stack.length - 1] : null;
      if (parent) parent.body.appendChild(node);

      var body = document.createElement('div');
      body.className = 'fold-body';
      node.parentNode.insertBefore(body, node.nextSibling);

      var section = {
        heading: node,
        body: body,
        level: level,
        button: null,
        collapsed: false
      };
      node.__foldSection = section;
      body.__foldSection = section;

      stack.push(section);
      sections.push(section);
    });

    return sections;
  }

  function addToggle(section) {
    var heading = section.heading;
    var title = (heading.textContent || '').trim();

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'fold-toggle';
    button.title = '折叠 / 展开这一节';
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-label', (title ? '折叠或展开：' + title : '折叠或展开这一节'));
    button.innerHTML = CHEVRON;

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(section, !section.collapsed, true);
    });

    heading.insertBefore(button, heading.firstChild);
    heading.classList.add('fold-heading');
    section.button = button;
  }

  function setCollapsed(section, collapsed, persist) {
    if (section.collapsed === collapsed) return;
    section.collapsed = collapsed;
    section.heading.classList.toggle('is-collapsed', collapsed);
    section.body.classList.toggle('is-collapsed', collapsed);
    if (section.button) {
      section.button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (persist) remember(section, collapsed);
  }

  function restore(sections) {
    var entry = readStore()[pageKey()];
    if (!entry) return;
    sections.forEach(function (section) {
      var id = section.heading.id;
      if (id && entry[id]) setCollapsed(section, true, false);
    });
  }

  /* --------------------------- 锚点跳转时展开 --------------------------- */

  /** 把某个元素外面所有折叠的祖先展开，否则点目录跳过去会是一片空白 */
  function expandAncestors(node, container) {
    var current = node ? node.parentNode : null;
    while (current && current !== container) {
      if (current.classList && current.classList.contains('fold-body')) {
        var section = current.__foldSection;
        if (section) setCollapsed(section, false, true);
      }
      current = current.parentNode;
    }
  }

  function findById(rawId) {
    if (!rawId) return null;
    var candidates = [rawId];
    ['decodeURIComponent', 'decodeURI'].forEach(function (name) {
      try {
        var decoded = window[name](rawId);
        if (decoded && candidates.indexOf(decoded) === -1) candidates.push(decoded);
      } catch (err) {
        // 非法百分号编码，忽略
      }
    });
    for (var i = 0; i < candidates.length; i++) {
      var found = document.getElementById(candidates[i]);
      if (found) return found;
    }
    return null;
  }

  function expandForHash(hash, container) {
    if (!hash || hash.charAt(0) !== '#' || hash.length < 2) return;
    var target = findById(hash.slice(1));
    if (!target) return;
    expandAncestors(target, container);
    // 目标本身就是标题时，把它自己那一节也展开：
    // 从目录跳过来是为了读内容，不能停在只有一个标题的空章节上
    if (isHeading(target) && target.__foldSection) {
      setCollapsed(target.__foldSection, false, true);
    }
  }

  /* -------------------------------- 启动 -------------------------------- */

  function init() {
    var container = document.getElementById(CONTAINER_ID);
    if (!container || container.dataset.foldReady === '1') return;
    // 加密文章的内容在解密前是空的，跳过
    if (container.querySelector('.hbe-container')) return;

    var headings = Array.prototype.filter.call(container.children, isHeading);
    if (!headings.length) return;

    container.dataset.foldReady = '1';

    var sections = buildSections(container);
    sections.forEach(addToggle);
    restore(sections);

    // 目录 / 页内锚点是用冒泡阶段监听点击的，这里用捕获阶段抢先展开目标所在的章节
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var link = target.closest('a[href^="#"]');
      if (!link) return;
      expandForHash(link.getAttribute('href'), container);
    }, true);

    window.addEventListener('hashchange', function () {
      expandForHash(window.location.hash, container);
    });

    // 带 #锚点 刷新页面时，先把目标章节展开，浏览器才滚得过去
    expandForHash(window.location.hash, container);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
