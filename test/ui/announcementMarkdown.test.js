// Announcement Markdown: visible syntax, fixed vnode output, URL safety and bounded parsing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnnouncementMarkdown, parseAnnouncementMarkdown, safeAnnouncementHref, safeAnnouncementImageSrc, ANNOUNCEMENT_MARKDOWN_LIMITS,
} from '../../public/js/ui/announcementMarkdown.js';
import { ANNOUNCEMENT_ASSET_URL_PREFIX } from '../../shared/announcementAssets.js';

const textOf = (value) => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return textOf(value.props?.children);
};
const elements = (value) => {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object') return [];
  return [value, ...elements(value.props?.children)];
};
const render = (source) => AnnouncementMarkdown({ source });
const blocks = (source) => parseAnnouncementMarkdown(source).blocks;
const paragraph = (source) => blocks(source)[0].children;

describe('announcement Markdown subset', () => {
  test('paragraphs preserve Chinese text, CRLF and each visible line break', () => {
    assert.deepEqual(blocks('第一行\r\n第二行\r\n\r\n第三段\r末行'), [
      { type: 'paragraph', children: [{ type: 'text', text: '第一行' }, { type: 'break' }, { type: 'text', text: '第二行' }] },
      { type: 'paragraph', children: [{ type: 'text', text: '第三段' }, { type: 'break' }, { type: 'text', text: '末行' }] },
    ]);
    assert.equal(elements(render('第一行\n第二行')).filter((v) => v.type === 'br').length, 1);
  });

  test('all six ATX heading levels render actual headings and preserve invalid headings', () => {
    const source = Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} 第${i + 1}级 ##`).join('\n');
    assert.deepEqual(blocks(source).map((b) => [b.type, b.level, b.children[0].text]),
      Array.from({ length: 6 }, (_, i) => ['heading', i + 1, `第${i + 1}级`]));
    assert.deepEqual(elements(render(source)).filter((v) => /^h[1-6]$/.test(v.type)).map((v) => v.type),
      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    assert.equal(textOf(render('####### 超出六级\n#没有空格')), '####### 超出六级#没有空格');
  });

  test('strong and emphasis nest, while underscores inside words remain text', () => {
    assert.deepEqual(paragraph('**粗体 *斜体*** 与 _强调_，file_name_test'), [
      { type: 'strong', children: [{ type: 'text', text: '粗体 ' }, { type: 'em', children: [{ type: 'text', text: '斜体' }] }] },
      { type: 'text', text: ' 与 ' }, { type: 'em', children: [{ type: 'text', text: '强调' }] },
      { type: 'text', text: '，file_name_test' },
    ]);
    assert.equal(elements(render('***粗斜体***')).filter((v) => ['strong', 'em'].includes(v.type)).length, 2);
    assert.equal(textOf(render('未闭合 **标记')), '未闭合 **标记');
  });

  test('backslash escapes keep literal punctuation and inline code stays literal', () => {
    assert.deepEqual(paragraph('\\*普通\\*，`<img src=x> **代码**`，``含 ` 反引号``'), [
      { type: 'text', text: '*普通*，' }, { type: 'code', text: '<img src=x> **代码**' },
      { type: 'text', text: '，' }, { type: 'code', text: '含 ` 反引号' },
    ]);
    assert.equal(textOf(render('尾部\\')), '尾部\\');
  });

  test('ordered/unordered lists retain ordered start, nested items and continuations', () => {
    const parsed = blocks('- 第一项\n  续行\n  - 子项\n- 第二项\n\n3. 第三\n4. 第四');
    assert.deepEqual(parsed.map((b) => [b.type, b.ordered, b.start, b.items.length]),
      [['list', false, undefined, 2], ['list', true, 3, 2]]);
    assert.equal(parsed[0].items[0][1].type, 'list');
    assert.deepEqual(parsed[0].items[0][0].children,
      [{ type: 'text', text: '第一项' }, { type: 'break' }, { type: 'text', text: '续行' }]);
    assert.equal(elements(render('3. 第三\n4. 第四')).find((v) => v.type === 'ol').props.start, 3);
    assert.equal(elements(render('- 第一\n\n- 第二')).filter((v) => v.type === 'li').length, 2);
  });

  test('quotes contain block syntax and rules accept spaced markers', () => {
    const parsed = blocks('> # 引用标题\n>\n> - 一项\n\n---\n\n* * *\n\n___');
    assert.equal(parsed[0].type, 'quote');
    assert.deepEqual(parsed[0].blocks.map((b) => b.type), ['heading', 'list']);
    assert.deepEqual(parsed.slice(1).map((b) => b.type), ['rule', 'rule', 'rule']);
    assert.equal(elements(render('> > 嵌套引用')).filter((v) => v.type === 'blockquote').length, 2);
  });

  test('fenced code never renders inner Markdown/HTML and closes only matching fences', () => {
    const source = '```js\n<script>alert(1)</script>\n[x](javascript:alert(1))\n~~~\n````\n\n后文';
    const parsed = blocks(source);
    assert.deepEqual(parsed[0], { type: 'codeBlock', language: 'js',
      text: '<script>alert(1)</script>\n[x](javascript:alert(1))\n~~~' });
    assert.equal(parsed[1].type, 'paragraph');
    const output = render(source), tags = elements(output).map((v) => v.type);
    assert.ok(tags.includes('pre') && tags.includes('code'));
    assert.ok(!tags.includes('script') && !tags.includes('a'));
    assert.equal(elements(output).find((v) => v.type === 'code').props['data-language'], 'js');
    assert.deepEqual(blocks('~~~\n没有关闭\n**仍是代码**')[0],
      { type: 'codeBlock', language: '', text: '没有关闭\n**仍是代码**' });
  });

  test('inline links allow balanced parentheses, emphasis labels and optional titles', () => {
    const parsed = paragraph('[**官网**](https://example.com/说明_(新版)?a=1&b=2 "标题") 和 [返回](../help#faq)');
    assert.deepEqual(parsed[0], { type: 'link', href: 'https://example.com/说明_(新版)?a=1&b=2', title: '标题',
      children: [{ type: 'strong', children: [{ type: 'text', text: '官网' }] }] });
    const links = elements(render('[官网](https://example.com) [邮件](mailto:a@example.com) [返回](#top)'))
      .filter((v) => v.type === 'a');
    assert.equal(links[0].props.target, '_blank');
    assert.equal(links[0].props.rel, 'noopener noreferrer');
    assert.equal(links[1].props.target, undefined);
    assert.equal(links[2].props.href, '#top');
  });

  test('reference links, tables, unsupported and malformed images stay visible text', () => {
    for (const source of ['![图](https://example.com/a.png)', '![图](javascript:alert(1))', '![图][ref]', '![](x)',
      '![**图**](https://example.com/a.png)', '![未闭合图', '![未闭合图\n下一行', '![图](**未闭合目标**', '![图][**未闭合引用**',
      '[参考][ref]', '[**参考**][ref]', '[**参考**][未闭合', '| 一 | 二 |\n| --- | --- |']) {
      const output = render(source);
      assert.equal(textOf(output), source.replace(/\n/g, ''), source);
      assert.ok(!elements(output).some((v) => ['a', 'img', 'table'].includes(v.type)), source);
      assert.equal(elements(output).filter((v) => v.type === 'br').length, source.split('\n').length - 1);
    }
  });

  test('malformed punctuation stays readable and cannot form nested anchors', () => {
    for (const source of ['[未关闭', '[文字](未关闭', '`未关闭', '普通 ](文字)', '\\', '<未关闭HTML']) {
      assert.equal(textOf(render(source)), source, source);
    }
    const output = render('[外层 [内层](https://inner.example)](https://outer.example)');
    assert.equal(elements(output).filter((v) => v.type === 'a').length, 1);
    assert.match(textOf(output), /\[内层\]\(https:\/\/inner\.example\)/);
  });
});

describe('announcement Markdown automatic HTTP links', () => {
  test('bare netdisk URLs keep query tokens, fragments and underscores; extraction codes stay text', () => {
    const href = 'https://pan.baidu.com/s/1share_A-b?pwd=a_B2&token=c%2Fd#download_part';
    const source = `下载：${href} 提取码：a_B2`, output = render(source);
    const link = elements(output).find((v) => v.type === 'a');
    assert.equal(link.props.href, href);
    assert.equal(textOf(link), href);
    assert.equal(link.props.target, '_blank');
    assert.equal(link.props.rel, 'noopener noreferrer');
    assert.equal(textOf(output), source);
    assert.equal(elements(output).filter((v) => ['strong', 'em'].includes(v.type)).length, 0);
    assert.equal(textOf(output).slice(textOf(output).indexOf('提取码')), '提取码：a_B2');
  });

  test('angle URLs become safe links, preserve the exact destination and do not swallow following text', () => {
    const href = 'HTTPS://pan.baidu.com/s/share_A?pwd=12_3#files';
    const output = render(`<${href}> 后文 http://example.com/download.zip`);
    const links = elements(output).filter((v) => v.type === 'a');
    assert.deepEqual(links.map((v) => v.props.href), [href, 'http://example.com/download.zip']);
    assert.equal(textOf(output), `${href} 后文 http://example.com/download.zip`);
    assert.ok(links.every((v) => v.props.target === '_blank' && v.props.rel === 'noopener noreferrer'));
  });

  test('sentence punctuation stays outside URLs, including paired parentheses and Chinese extraction-code separators', () => {
    for (const punctuation of ['.', ',', ';', ':', '!', '?', '...', '，', '。', '；', '：', '！', '？', '、', '…', '）', '】', '”', '’']) {
      const href = 'https://example.com/path_(v2)?token=a_B#part_1';
      const output = render(`链接 ${href}${punctuation} 提取码：abcd`);
      assert.equal(elements(output).find((v) => v.type === 'a').props.href, href, punctuation);
      assert.equal(textOf(output), `链接 ${href}${punctuation} 提取码：abcd`, punctuation);
    }
    const output = render('(https://example.com/path_(v2)).\nhttps://example.com/a[0]?items=a,b，提取码：abcd');
    assert.deepEqual(elements(output).filter((v) => v.type === 'a').map((v) => v.props.href),
      ['https://example.com/path_(v2)', 'https://example.com/a[0]?items=a,b']);
    assert.equal(textOf(output), '(https://example.com/path_(v2)).https://example.com/a[0]?items=a,b，提取码：abcd');
  });

  test('automatic links work in headings, lists, quotes and strong text with ordinary Markdown precedence', () => {
    const source = '# https://example.com/title\n\n- **https://example.com/download**\n\n> https://example.com/quote';
    const output = render(source), nodes = elements(output);
    assert.deepEqual(nodes.filter((v) => v.type === 'a').map((v) => v.props.href),
      ['https://example.com/title', 'https://example.com/download', 'https://example.com/quote']);
    assert.ok(elements(nodes.find((v) => v.type === 'strong')).some((v) => v.type === 'a'));
  });

  test('explicit links remain one anchor; image alt, raw HTML and code never gain automatic anchors', () => {
    const source = '[https://inner.example/a_b <https://inner.example/angle>](https://outer.example)';
    const nodes = elements(render(source)), links = nodes.filter((v) => v.type === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, 'https://outer.example');
    assert.equal(textOf(links[0]), 'https://inner.example/a_b <https://inner.example/angle>');
    for (const literal of ['`https://example.com/a_b`', '```text\nhttps://example.com/a_b\n<https://example.com>\n```',
      '<img src="https://example.com/image.png">', '<div>https://example.com/plain\n<https://example.com/angle>\n</div>',
      '![https://example.com/alt](assets/banner.png)', '![图](https://example.com/image.png)', '![图][https://example.com/ref]',
      '[https://example.com/ref][reference]']) {
      assert.ok(!elements(render(literal)).some((v) => v.type === 'a'), literal);
    }
    assert.equal(safeAnnouncementImageSrc('https://example.com/banner.png'), null);
    assert.equal(elements(render('[![图](assets/banner.png)](https://example.com/full)')).filter((v) => v.type === 'a').length, 1);
  });

  test('rejected and incomplete Markdown link/image syntax cannot produce partial automatic anchors', () => {
    for (const source of ['[下载](javascript:https://example.com)', '[下载](https://example.com/ bad-title)',
      '[下载](https://example.com/未闭合', '[未闭合标签 https://example.com/download',
      '![图](https://example.com/not-an-announcement-asset.png)', '![图](https://example.com/未闭合',
      '![未闭合图 https://example.com/download', '<https://example.com/未闭合', '<https://example.com/ 有空格>',
      '<https://example.com/ >', '<https://example.com/path<https://inner.example>>']) {
      const output = render(source);
      assert.equal(textOf(output), source, source);
      assert.ok(!elements(output).some((v) => v.type === 'a'), source);
    }
    const source = '[下载](https://example.com/未闭合\n下一行 https://example.com/valid';
    const links = elements(render(source)).filter((v) => v.type === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, 'https://example.com/valid');
  });

  test('unsafe schemes, encoded/credential destinations, escaped angles and URLs inside words stay nonclickable', () => {
    for (const source of ['javascript:https://example.com', 'data:https://example.com', 'file:https://example.com',
      '//example.com/path', 'www.example.com', 'https:///example.com/path', 'https://user:pass@example.com/path',
      'https://example.com/%ZZ', 'https://example.com/\\bad', 'https://example.com/java&#x09;script:',
      '<javascript:alert(1)>', '<https://user:pass@example.com/path>', '\\<https://example.com/path>',
      'xhttps://example.com/path', 'prefix_https://example.com/path', 'https%3a%2f%2fexample.com/path']) {
      assert.ok(!elements(render(source)).some((v) => v.type === 'a'), source);
    }
    const href = 'https://example.com/download?token=%26%22%3C#files_1';
    const link = elements(render(href)).find((v) => v.type === 'a');
    assert.equal(link.props.href, href);
    assert.ok(Object.keys(link.props).every((key) => !/^on/i.test(key)));
    assert.ok(!('dangerouslySetInnerHTML' in link.props));
  });

  test('automatic anchors share the node budget and repeated incomplete candidates stay bounded literal text', () => {
    const source = 'https://x.test '.repeat(3500);
    const output = render(source);
    assert.equal(parseAnnouncementMarkdown(source).truncated, true);
    assert.ok(elements(output).filter((v) => v.type === 'a').length <= ANNOUNCEMENT_MARKDOWN_LIMITS.nodes / 2);
    assert.equal(elements(output).filter((v) => v.props.class === 'announcement-markdown__notice').length, 1);
    for (const literal of ['<https://'.repeat(5000), '[https://'.repeat(5000), 'https://%ZZ/'.repeat(4000)]) {
      assert.equal(textOf(render(literal)), literal);
      assert.ok(!elements(render(literal)).some((v) => v.type === 'a'));
      assert.equal(parseAnnouncementMarkdown(literal).truncated, false);
    }
  });
});

describe('announcement Markdown images', () => {
  test('all documented source forms resolve only to the dedicated announcement-asset route', () => {
    for (const source of ['assets/banner.png', './assets/banner.png', `${ANNOUNCEMENT_ASSET_URL_PREFIX}banner.png`]) {
      assert.equal(safeAnnouncementImageSrc(source), `${ANNOUNCEMENT_ASSET_URL_PREFIX}banner.png`);
      assert.deepEqual(paragraph(`![公告图](${source} "说明")`), [{ type: 'image',
        src: `${ANNOUNCEMENT_ASSET_URL_PREFIX}banner.png`, title: '说明', alt: '公告图' }]);
    }
    const image = elements(render('![公告图](assets/banner.png "说明")')).find((v) => v.type === 'img');
    assert.equal(image.props.class, 'announcement-markdown__image');
    assert.equal(image.props.src, `${ANNOUNCEMENT_ASSET_URL_PREFIX}banner.png`);
    assert.equal(image.props.alt, '公告图');
    assert.equal(image.props.title, '说明');
    assert.equal(image.props.loading, 'lazy');
    assert.equal(image.props.decoding, 'async');
    assert.equal(image.props.referrerPolicy, 'no-referrer');
    assert.ok(!('dangerouslySetInnerHTML' in image.props));
    assert.ok(Object.keys(image.props).every((key) => !/^on/i.test(key)));
  });

  test('Chinese, spaces and balanced parentheses in paths are encoded once', () => {
    for (const source of ['assets/图片/图%201.png', './assets/图片/图 1.png', `${ANNOUNCEMENT_ASSET_URL_PREFIX}%E5%9B%BE%E7%89%87/%E5%9B%BE%201.png`]) {
      assert.equal(safeAnnouncementImageSrc(source), `${ANNOUNCEMENT_ASSET_URL_PREFIX}%E5%9B%BE%E7%89%87/%E5%9B%BE%201.png`);
    }
    const image = elements(render('![文字](<assets/图片/图 1.png> "标题")')).find((v) => v.type === 'img');
    assert.equal(image.props.src, `${ANNOUNCEMENT_ASSET_URL_PREFIX}%E5%9B%BE%E7%89%87/%E5%9B%BE%201.png`);
    assert.equal(paragraph('![图](assets/banner_(v2).png)')[0].src, `${ANNOUNCEMENT_ASSET_URL_PREFIX}banner_(v2).png`);
    assert.equal(safeAnnouncementImageSrc('assets/banner.JPG'), `${ANNOUNCEMENT_ASSET_URL_PREFIX}banner.JPG`);
  });

  test('escaped alt text becomes ordinary accessible text without creating nested requests', () => {
    const image = elements(render('![示例\\[一\\] **粗体** `代码` \\"标题\\"](assets/banner.png)')).find((v) => v.type === 'img');
    assert.equal(image.props.alt, '示例[一] 粗体 代码 "标题"');
    assert.equal(paragraph('![](assets/banner.png)')[0].alt, '');
    const nested = elements(render('![![内图](assets/inner.png)](assets/outer.png)'));
    assert.equal(nested.filter((v) => v.type === 'img').length, 1);
    assert.equal(nested.find((v) => v.type === 'img').props.alt, '![内图](assets/inner.png)');
    assert.ok(!nested.some((v) => v.type === 'a'));
  });

  test('an image can be the label of one safe link without changing link behavior', () => {
    const output = render('[![缩略图](assets/banner_(v2).png "图注")](https://example.com/full)');
    const nodes = elements(output), link = nodes.find((v) => v.type === 'a'), image = nodes.find((v) => v.type === 'img');
    assert.equal(nodes.filter((v) => v.type === 'a').length, 1);
    assert.equal(nodes.filter((v) => v.type === 'img').length, 1);
    assert.equal(link.props.href, 'https://example.com/full');
    assert.equal(link.props.rel, 'noopener noreferrer');
    assert.ok(elements(link.props.children).includes(image));
    assert.equal(image.props.alt, '缩略图');
    assert.equal(image.props.title, '图注');
    assert.equal(safeAnnouncementHref('http://example.com/path'), 'http://example.com/path');
  });

  test('HTML in alt text and quoted titles stays inside fixed text attributes', () => {
    const source = `![<img src=x onerror=alert(1)>](assets/banner.png '\"><svg onload=alert(1)>')`;
    const nodes = elements(render(source)), image = nodes.find((v) => v.type === 'img');
    assert.equal(nodes.filter((v) => v.type === 'img').length, 1);
    assert.ok(nodes.every((v) => ['div', 'p', 'img'].includes(v.type)));
    assert.equal(image.props.alt, '<img src=x onerror=alert(1)>');
    assert.equal(image.props.title, '\"><svg onload=alert(1)>');
    assert.ok(Object.keys(image.props).every((key) => !/^on/i.test(key)));
    assert.ok(!('dangerouslySetInnerHTML' in image.props));
  });

  test('external URLs, other site paths, non-images and encoded traversal never create image nodes', () => {
    for (const source of ['https://example.com/banner.png', 'http://example.com/banner.png', '//example.com/banner.png',
      'javascript:alert(1)', 'data:image/png;base64,AA', 'file:///C:/banner.png', 'mailto:a@example.com',
      '%6aavascript%3aalert(1)', 'https%3a%2f%2fexample.com/banner.png', '/assets/banner.png', '/public/banner.png',
      'banner.png', '../assets/banner.png', '/api/announcements/article', 'assets/banner.svg', 'assets/banner.html',
      'assets/index.json', 'assets/../banner.png', 'assets/%2e%2e/banner.png', 'assets/%252e%252e/banner.png',
      'assets/.private/banner.png', 'assets/a%2fbanner.png', 'assets/a%5cbanner.png', 'assets/a\\banner.png',
      'assets/banner.png?secret=1', 'assets/banner.png#fragment', 'assets//banner.png', 'assets/con.png', 'assets/a%00.png', 'assets/\ud800.png']) {
      assert.equal(safeAnnouncementImageSrc(source), null, source);
      const markdown = `![图](${source})`, output = render(markdown);
      assert.equal(textOf(output), markdown, source);
      assert.ok(!elements(output).some((v) => v.type === 'img'), source);
    }
    for (const source of ['', null, undefined, 42, {}]) assert.equal(safeAnnouncementImageSrc(source), null);
  });

  test('raw HTML, code, reference images and escaped image markers never load images', () => {
    for (const source of ['<img src="/api/announcement-assets/banner.png" onerror="alert(1)">',
      '<div>![图](assets/banner.png)</div>', '`![图](assets/banner.png)`', '```md\n![图](assets/banner.png)\n```',
      '![图][banner]', '![图](assets/banner.png', '\\![图](assets/banner.png)']) {
      const output = render(source);
      assert.ok(!elements(output).some((v) => v.type === 'img'), source);
      assert.ok(textOf(output).includes('图') || textOf(output).includes('<img'), source);
    }
    for (const source of ['![**图**](assets/未闭合', '![图](**未闭合目标**', '![图][**未闭合引用**']) {
      assert.equal(textOf(render(source)), source);
    }
  });

  test('the image budget applies across blocks and linked images, and resets for the next document', () => {
    const limit = ANNOUNCEMENT_MARKDOWN_LIMITS.images;
    const source = Array.from({ length: limit }, (_, i) => `[![第${i}图](assets/banner.png)](https://example.com/full)`).join('\n\n');
    assert.equal(parseAnnouncementMarkdown(source).truncated, false);
    assert.equal(elements(render(source)).filter((v) => v.type === 'img').length, limit);
    const overflow = source + '\n\n![超量](assets/extra.png)\n后文';
    assert.equal(parseAnnouncementMarkdown(overflow).truncated, true);
    const output = render(overflow);
    assert.equal(elements(output).filter((v) => v.type === 'img').length, limit);
    assert.equal(elements(output).filter((v) => v.props.class === 'announcement-markdown__notice').length, 1);
    assert.ok(!textOf(output).includes('后文'));
    assert.equal(parseAnnouncementMarkdown('![新公告](assets/banner.png)').truncated, false);
    assert.equal(elements(render('![新公告](assets/banner.png)')).filter((v) => v.type === 'img').length, 1);
  });
});

describe('announcement Markdown safety and bounds', () => {
  test('only expected protocols or site-relative destinations are accepted', () => {
    for (const href of ['https://example.com', 'HTTP://example.com/中文', 'https://example.com/a%20b?q=a%26b',
      'mailto:a@example.com?subject=%E5%85%AC%E5%91%8A', '/help', './help', '../help', 'help/page?a=1&b=2', '?page=2', '#top']) {
      assert.equal(safeAnnouncementHref(href), href, href);
    }
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<svg>',
      'file:///C:/Windows', 'blob:https://example.com/id', '//other.example/path', '\\other.example',
      'http:example.com', 'https:///example.com', 'mailto:', 'https://user:pass@example.com',
      'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)', '\u0000javascript:alert(1)',
      '&#106;avascript:alert(1)', 'java&#x09;script:alert(1)', 'javascript&colon;alert(1)',
      '%6aavascript%3aalert(1)', 'javascript%3aalert(1)', '%76%62script:msgbox(1)', '%', 'https://example.com/<svg>']) {
      assert.equal(safeAnnouncementHref(href), null, JSON.stringify(href));
    }
    assert.equal(safeAnnouncementHref(null), null);
  });

  test('rejected links keep all their source text without any clickable element', () => {
    for (const destination of ['javascript:alert(1)', 'DATA:text/html,<script>', 'java\tscript:alert(1)',
      'javascript&colon;alert(1)', '&#106;avascript:alert(1)', '%6aavascript%3aalert(1)', '//evil.example']) {
      const source = `[点击](${destination})`, output = render(source);
      assert.equal(textOf(output), source);
      assert.ok(!elements(output).some((v) => v.type === 'a'), source);
    }
  });

  test('raw HTML and attribute-injection attempts stay ordinary text', () => {
    const source = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<svg onload=alert(1)>\n' +
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>\n' +
      '[坏链接](https://example.com/" onmouseover="alert(1))';
    const output = render(source), nodes = elements(output);
    assert.equal(textOf(output), source.replace(/\n/g, ''));
    assert.ok(nodes.every((v) => ['div', 'p', 'br'].includes(v.type)));
    for (const node of nodes) {
      assert.ok(!('dangerouslySetInnerHTML' in node.props));
      assert.ok(Object.keys(node.props).every((key) => !/^on/i.test(key)), node.type);
    }
    // Quotes and ampersands are a single href value, never concatenated into HTML markup.
    const href = 'https://example.com/"quoted"?a=1&b=2';
    const link = elements(render(`[安全](${href})`)).find((v) => v.type === 'a');
    assert.equal(link.props.href, href);
    assert.equal(link.props.onmouseover, undefined);
  });

  test('Markdown within HTML elements remains literal, including multiline and unclosed elements', () => {
    for (const source of ['<b>**文字**</b>', '<b><i>*嵌套*</i></b>', '<script>\n[点击](https://example.com)\n</script>',
      '<b>**未闭合元素**', '<svg onload="alert(1)">[链接](javascript:alert(1))</svg>']) {
      const output = render(source);
      assert.equal(textOf(output), source.replace(/\n/g, ''), source);
      assert.ok(elements(output).every((v) => ['div', 'p', 'br'].includes(v.type)), source);
    }
    assert.equal(elements(render('<b>**原文**</b> 与 *外部 Markdown*')).filter((v) => v.type === 'em').length, 1);
  });

  test('language metadata is bounded and cannot create arbitrary element attributes', () => {
    const node = elements(render('```js" onclick="bad\n内容\n```')).find((v) => v.type === 'code');
    assert.equal(node.props['data-language'], undefined);
    assert.equal(textOf(node), '内容');
    assert.equal(Object.keys(node.props).filter((key) => /^on/i.test(key)).length, 0);
  });

  test('empty and invalid source values do not coerce user-controlled objects', () => {
    for (const source of ['', ' \n\n', null, undefined, 42, { toString() { throw new Error('must not execute'); } }]) {
      assert.deepEqual(parseAnnouncementMarkdown(source), { blocks: [], truncated: false });
      assert.equal(textOf(render(source)), '');
    }
  });

  test('oversized text has an explicit notice and never splits an emoji', () => {
    const limit = ANNOUNCEMENT_MARKDOWN_LIMITS.chars;
    const source = 'a'.repeat(limit - 1) + '😀' + '后文';
    const result = parseAnnouncementMarkdown(source);
    assert.equal(result.truncated, true);
    assert.equal(result.blocks[0].children[0].text, 'a'.repeat(limit - 1));
    const output = render(source);
    assert.equal(elements(output).filter((v) => v.props.class === 'announcement-markdown__notice').length, 1);
    assert.match(textOf(output), /已截断显示/);
    assert.equal(parseAnnouncementMarkdown('a'.repeat(limit)).truncated, false);
  });

  test('a large number of formatted nodes is capped and does not produce an unbounded DOM tree', () => {
    const source = '*x* '.repeat(12000), output = render(source);
    assert.equal(parseAnnouncementMarkdown(source).truncated, true);
    assert.ok(elements(output).length <= ANNOUNCEMENT_MARKDOWN_LIMITS.nodes + ANNOUNCEMENT_MARKDOWN_LIMITS.depth + 2);
    assert.match(textOf(output), /已截断显示/);
  });

  test('unmatched punctuation and deeply nested blocks remain bounded without losing literal text', () => {
    for (const marker of ['[', '`', '(', '*']) {
      const source = '文本 ' + marker.repeat(ANNOUNCEMENT_MARKDOWN_LIMITS.chars - 3);
      assert.equal(textOf(render(source)), source, marker);
    }
    const incompleteTag = '文本 <a-' + 'a-'.repeat(20000);
    assert.equal(textOf(render(incompleteTag)), incompleteTag);
    const quote = '> '.repeat(10000) + '深层文本';
    const output = render(quote);
    assert.equal(elements(output).filter((v) => v.type === 'blockquote').length, ANNOUNCEMENT_MARKDOWN_LIMITS.depth);
    assert.ok(textOf(output).endsWith('深层文本'));
    assert.ok(textOf(output).startsWith('> '));
  });
});
