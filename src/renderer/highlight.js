'use strict';

// 코드·텍스트 미리보기용 경량 구문 강조. 외부 라이브러리 없이 정규식 토크나이저로 줄 단위 DOM을 만든다.
// files.js보다 먼저 로드되어 HL_EXT(확장자 → 언어)와 hlRender를 제공한다.

const HL_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
  kt: 'kt', kts: 'kt',
  java: 'java', gradle: 'java',
  json: 'json', jsonc: 'json', json5: 'json',
  xml: 'xml', html: 'xml', htm: 'xml',
  yml: 'yaml', yaml: 'yaml',
  py: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  properties: 'conf', ini: 'conf', toml: 'conf', conf: 'conf', cfg: 'conf', env: 'conf',
  txt: '', log: '', md: '', csv: '', tsv: '',
};

const HL_DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const HL_SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;
const HL_BLOCK_COMMENT = String.raw`\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`;
const HL_C_NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[LlFfnuUd]?\b`;

const hlWords = text => new Set(text.split(' '));

const HL_JS_KW = hlWords('async await break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface let new of package private protected public return static super switch this throw try typeof var void while with yield as readonly abstract declare namespace type keyof satisfies get set');
const HL_JS_LIT = hlWords('true false null undefined NaN Infinity');
const HL_TS_TYPES = hlWords('string number boolean any unknown never object symbol bigint');
const HL_KT_KW = hlWords('abstract as break by catch class companion const constructor continue crossinline data do else enum external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias typeof val var vararg when where while');
const HL_KT_LIT = hlWords('true false null');
const HL_JAVA_KW = hlWords('abstract assert break case catch class const continue def default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public record return static strictfp super switch synchronized this throw throws transient try var volatile while');
const HL_JAVA_TYPES = hlWords('boolean byte char double float int long short void');
const HL_PY_KW = hlWords('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls');
const HL_PY_LIT = hlWords('True False None');
const HL_SH_KW = hlWords('if then else elif fi for while until do done case esac in function select time return exit break continue export local readonly declare unset source alias');
const HL_CONF_LIT = hlWords('true false null yes no on off');

// 식별자의 의미: 키워드 > 리터럴 > 내장 타입 > 대문자로 시작하는 타입 > 함수 호출
function hlWordClass(def, word, next) {
  if (def.keywords?.has(word)) return 'keyword';
  if (def.literals?.has(word)) return 'literal';
  if (def.types?.has(word)) return 'type';
  if (/^[A-Z]/.test(word) && /[a-z]/.test(word)) return 'type';
  if (next === '(') return 'func';
  return '';
}

function hlDef(rules, extra = {}) {
  return { names: rules.map(([name]) => name), re: new RegExp(rules.map(([name, source]) => `(?<${name}>${source})`).join('|'), 'gm'), ...extra };
}

const hlClike = (keywords, literals, types, extraRules = []) => hlDef([
  ['comment', String.raw`\/\/[^\n]*|` + HL_BLOCK_COMMENT],
  ...extraRules,
  ['string', `${HL_DQ}|${HL_SQ}`],
  ['annot', String.raw`@[A-Za-z_]\w*`],
  ['number', HL_C_NUMBER],
  ['word', String.raw`[A-Za-z_$][\w$]*`],
], { keywords, literals, types });

const HL_BUILDERS = {
  js: () => hlClike(HL_JS_KW, HL_JS_LIT, null, [['string2', '`(?:\\\\[\\s\\S]|[^`\\\\])*`?']]),
  ts: () => hlClike(HL_JS_KW, HL_JS_LIT, HL_TS_TYPES, [['string2', '`(?:\\\\[\\s\\S]|[^`\\\\])*`?']]),
  kt: () => hlClike(HL_KT_KW, HL_KT_LIT, null, [['string2', String.raw`"""[\s\S]*?(?:"""|(?![\s\S]))`]]),
  java: () => hlClike(HL_JAVA_KW, HL_JS_LIT, HL_JAVA_TYPES),
  json: () => hlDef([
    ['comment', String.raw`\/\/[^\n]*|` + HL_BLOCK_COMMENT],
    ['key', String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`],
    ['string', HL_DQ],
    ['number', String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`],
    ['literal', String.raw`\b(?:true|false|null)\b`],
  ]),
  yaml: () => hlDef([
    ['comment', String.raw`(?<=^|\s)#[^\n]*`],
    ['key', String.raw`(?<=^[ \t-]*)[^\s#:"'{\[\-][^:#\n]*?(?=:(?:\s|(?![\s\S])))`],
    ['string', String.raw`"(?:\\.|[^"\\\n])*"|'[^'\n]*'`],
    ['punct', String.raw`^(?:---|\.\.\.)(?=\s|(?![\s\S]))`],
    ['var', String.raw`[&*][\w-]+`],
    ['number', String.raw`(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.-])`],
    ['literal', String.raw`\b(?:true|false|null|True|False|Null|yes|no)\b`],
  ]),
  conf: () => hlDef([
    ['comment', String.raw`^[ \t]*[#;][^\n]*`],
    ['section', String.raw`^[ \t]*\[[^\]\n]+\]`],
    ['key', String.raw`^[ \t]*[\w.\-\/]+(?=[ \t]*[=:])`],
    ['string', String.raw`"(?:\\.|[^"\\\n])*"|'[^'\n]*'`],
    ['number', String.raw`(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.-])`],
    ['word', String.raw`[A-Za-z_]\w*`],
  ], { literals: HL_CONF_LIT }),
  py: () => hlDef([
    ['comment', String.raw`#[^\n]*`],
    ['string', String.raw`[rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)`],
    ['annot', String.raw`@[\w.]+`],
    ['number', HL_C_NUMBER],
    ['word', String.raw`[A-Za-z_]\w*`],
  ], { keywords: HL_PY_KW, literals: HL_PY_LIT }),
  sh: () => hlDef([
    ['comment', String.raw`(?<![\w$])#[^\n]*`],
    ['string', String.raw`"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?`],
    ['var', String.raw`\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[0-9@#?$!*-])`],
    ['number', String.raw`\b\d+\b`],
    ['word', String.raw`[A-Za-z_][\w-]*`],
  ], { keywords: HL_SH_KW }),
  xml: () => hlDef([
    ['comment', String.raw`<!--[\s\S]*?(?:-->|(?![\s\S]))`],
    ['string', String.raw`<!\[CDATA\[[\s\S]*?(?:\]\]>|(?![\s\S]))`],
    ['annot', String.raw`<[!?][^>]*>?`],
    ['tag', String.raw`<\/?[A-Za-z_][\w:.\-]*(?:"[^"]*"|'[^']*'|[^>"'])*>?`],
    ['literal', String.raw`&(?:#\d+|#x[\da-fA-F]+|\w+);`],
  ]),
};

const HL_TAG_PARTS = /(?<name>^<\/?[^\s\/>]+)|(?<attr>[^\s=\/>"']+(?=\s*=))|(?<value>"[^"]*"|'[^']*')|(?<punct>\/?>|=)/g;
const HL_TAG_CLASS = { name: 'tag', attr: 'attr', value: 'string', punct: 'punct' };
const hlDefs = new Map();

function hlSplitTag(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(HL_TAG_PARTS)) {
    if (m.index > last) parts.push(['', text.slice(last, m.index)]);
    const group = Object.keys(m.groups).find(name => m.groups[name] !== undefined);
    parts.push([HL_TAG_CLASS[group], m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(['', text.slice(last)]);
  return parts;
}

function hlTokens(text, lang) {
  const builder = HL_BUILDERS[lang];
  if (!builder) return [['', text]];
  if (!hlDefs.has(lang)) hlDefs.set(lang, builder());
  const def = hlDefs.get(lang);
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(def.re)) {
    if (m.index > last) tokens.push(['', text.slice(last, m.index)]);
    last = m.index + m[0].length;
    const group = def.names.find(name => m.groups[name] !== undefined);
    if (group === 'tag') tokens.push(...hlSplitTag(m[0]));
    else if (group === 'word') tokens.push([hlWordClass(def, m[0], text[last]), m[0]]);
    else tokens.push([group.replace(/\d+$/, ''), m[0]]);
  }
  if (last < text.length) tokens.push(['', text.slice(last)]);
  return tokens;
}

// 줄 번호는 CSS counter가 그린다. 여러 줄에 걸친 토큰(블록 주석, 템플릿 문자열)은 줄마다 나눠 담는다.
function hlRender(source, lang) {
  const text = source.replace(/\r\n?/g, '\n');
  const pre = document.createElement('pre');
  pre.className = 'fx-code';
  let line = document.createElement('div');
  line.className = 'fx-line';
  for (const [cls, token] of hlTokens(text, lang)) {
    token.split('\n').forEach((part, index) => {
      if (index) { pre.append(line); line = document.createElement('div'); line.className = 'fx-line'; }
      if (!part) return;
      if (!cls) { line.append(part); return; }
      const span = document.createElement('span');
      span.className = `tok-${cls}`;
      span.textContent = part;
      line.append(span);
    });
  }
  if (line.childNodes.length || !pre.childNodes.length) pre.append(line);
  return pre;
}
