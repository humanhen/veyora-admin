/* Minimal DOM + script loader for the Veyora admin frontend tests.

   The admin panel is a dependency-free vanilla-JS SPA loaded as plain <script>
   tags, so there is no module system to import and no bundler to hook. Rather
   than add a framework, a test runner or a headless browser — none of which
   this frontend has ever had — these tests do what the API tests already do
   with fakeClient()/makeDb(): hand-build the double.

   What this provides is a small DOM: enough to set innerHTML, parse it, query
   it with the selectors the panel actually uses, read element state, and fire
   the handlers the panel attaches. Tests then drive the REAL shipped
   js/*.js files in a vm context. They exercise rendered output and behaviour,
   not source strings.

   It is deliberately not a browser. It implements the subset the admin panel
   uses and throws on selectors it does not understand, so an unsupported
   query fails loudly instead of silently matching nothing and turning a real
   regression into a green test. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.dirname(path.dirname(__dirname));
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

/* ---------------------------------------------------------------------------
   Nodes
   --------------------------------------------------------------------------- */

class ClassList {
  constructor(el){ this.el = el; }
  get _set(){ return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(s){ this.el.className = [...s].join(' '); }
  add(...c){ const s = this._set; c.forEach(x => s.add(x)); this._write(s); }
  remove(...c){ const s = this._set; c.forEach(x => s.delete(x)); this._write(s); }
  contains(c){ return this._set.has(c); }
  toggle(c, force){
    const s = this._set;
    const on = force === undefined ? !s.has(c) : !!force;
    if (on) s.add(c); else s.delete(c);
    this._write(s);
    return on;
  }
}

class TextNode {
  constructor(text){ this.nodeType = 3; this.textContent = text; this.children = []; }
  get outerHTML(){ return this.textContent; }
}

class Element {
  constructor(tag, doc){
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.children = [];          // element children only
    this.childNodes = [];        // elements + text
    this.parentNode = null;
    this.ownerDocument = doc;
    this.style = {};
    this.classList = new ClassList(this);
    this._listeners = {};
    /* Handler properties the panel assigns (el.onclick = fn). Kept as plain
       own properties so assignment works exactly as it does in a browser. */
    this.onclick = null; this.onchange = null; this.oninput = null;
    this.onsubmit = null; this.onkeydown = null;
  }

  /* ---- attributes ---- */
  setAttribute(name, value){ this.attributes[name] = String(value); }
  getAttribute(name){ return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name){ return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name){ delete this.attributes[name]; }

  get className(){ return this.attributes.class || ''; }
  set className(v){ this.attributes.class = String(v); }
  get id(){ return this.attributes.id || ''; }
  set id(v){ this.attributes.id = String(v); }

  /** data-* access, camelCased like the real thing. */
  get dataset(){
    const out = {};
    for (const [k, v] of Object.entries(this.attributes)) {
      if (!k.startsWith('data-')) continue;
      out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    return out;
  }

  /* Form-control state. `checked`/`disabled`/`value` are live properties in a
     browser but arrive as HTML attributes here, so they are bridged. */
  get checked(){ return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v){ this._checked = !!v; }
  get disabled(){ return this._disabled !== undefined ? this._disabled : this.hasAttribute('disabled'); }
  set disabled(v){ this._disabled = !!v; }
  get value(){ return this._value !== undefined ? this._value : (this.attributes.value || ''); }
  set value(v){ this._value = String(v); }
  get type(){ return this.attributes.type || ''; }

  /* ---- tree ---- */
  appendChild(node){
    node.parentNode = this;
    this.childNodes.push(node);
    if (node.nodeType === 1) this.children.push(node);
    return node;
  }
  remove(){
    const p = this.parentNode;
    if (!p) return;
    p.childNodes = p.childNodes.filter(n => n !== this);
    p.children = p.children.filter(n => n !== this);
    this.parentNode = null;
  }
  insertAdjacentHTML(_pos, html){
    const frag = parseHTML(html, this.ownerDocument);
    frag.forEach(n => this.appendChild(n));
  }

  /* ---- content ---- */
  get innerHTML(){ return this.childNodes.map(n => n.outerHTML).join(''); }
  set innerHTML(html){
    this.childNodes = [];
    this.children = [];
    parseHTML(html, this.ownerDocument).forEach(n => this.appendChild(n));
  }
  get outerHTML(){
    const attrs = Object.entries(this.attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
    const tag = this.tagName.toLowerCase();
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  get textContent(){
    return this.childNodes.map(n => n.nodeType === 3 ? n.textContent : n.textContent).join('');
  }
  set textContent(v){
    this.childNodes = [];
    this.children = [];
    this.appendChild(new TextNode(String(v)));
  }

  /* ---- queries ---- */
  _descendants(){
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel){ return this._descendants().filter(el => matches(el, sel)); }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
  closest(sel){
    let n = this;
    while (n) { if (n.nodeType === 1 && matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }

  /* ---- events ---- */
  addEventListener(type, fn){ (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn){
    this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
  }
  dispatch(type, event){
    const ev = Object.assign({ type, target: this, preventDefault(){ this.defaultPrevented = true; }, defaultPrevented: false }, event || {});
    const prop = this['on' + type];
    if (typeof prop === 'function') prop.call(this, ev);
    (this._listeners[type] || []).forEach(fn => fn.call(this, ev));
    return ev;
  }
  /* Convenience drivers used by the tests. */
  click(){
    if (this.disabled) return null;   // a disabled control does nothing, as in a browser
    return this.dispatch('click');
  }
  check(on){ this.checked = on === undefined ? true : !!on; return this.dispatch('change'); }
  typeInto(v){ this.value = v; return this.dispatch('input'); }
  selectValue(v){ this.value = v; return this.dispatch('change'); }
  submit(){ return this.dispatch('submit'); }
  setSelectionRange(){}
  focus(){ this.ownerDocument._active = this; }
  scrollIntoView(){}
}

/* ---------------------------------------------------------------------------
   Selector matching — #id, .class, tag, [attr], [attr=value], and a tag or
   class followed by an attribute filter. Anything else throws.
   --------------------------------------------------------------------------- */
function matches(el, sel){
  const parts = String(sel).trim().split(/\s*,\s*/);
  return parts.some(part => matchOne(el, part.trim()));
}

function matchOne(el, sel){
  const re = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)((?:\[[^\]]+\])*)$/;
  const m = re.exec(sel);
  if (!m) throw new Error(`dom shim: unsupported selector "${sel}"`);
  const [, tag, idsAndClasses, attrs] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const token of idsAndClasses.match(/[#.][\w-]+/g) || []) {
    if (token[0] === '#') { if (el.id !== token.slice(1)) return false; }
    else if (!el.classList.contains(token.slice(1))) return false;
  }
  for (const token of attrs.match(/\[[^\]]+\]/g) || []) {
    const body = token.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq === -1) { if (!el.hasAttribute(body)) return false; continue; }
    const name = body.slice(0, eq);
    const want = body.slice(eq + 1).replace(/^['"]|['"]$/g, '');
    if (el.getAttribute(name) !== want) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
   HTML parser — tags, attributes, text, comments, void elements.
   --------------------------------------------------------------------------- */
function parseHTML(html, doc){
  const src = String(html == null ? '' : html);
  const roots = [];
  const stack = [];
  const push = (node) => { (stack.length ? stack[stack.length - 1] : { appendChild: n => roots.push(n) }).appendChild(node); };
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { const t = src.slice(i); if (t) push(new TextNode(t)); break; }
    if (lt > i) { const t = src.slice(i, lt); if (t) push(new TextNode(t)); }

    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt); i = end === -1 ? src.length : end + 3; continue; }

    const gt = findTagEnd(src, lt);
    if (gt === -1) { push(new TextNode(src.slice(lt))); break; }
    const raw = src.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (raw.startsWith('/')) {                       // closing tag
      const name = raw.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tagName === name.toUpperCase()) { stack.length = s; break; }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([a-zA-Z][\w-]*)/.exec(body);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();
    const el = new Element(tag, doc);
    for (const [, k, , v1, v2, v3] of body.slice(nameMatch[1].length).matchAll(/([\w:-]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      el.setAttribute(k, v1 !== undefined ? v1 : v2 !== undefined ? v2 : v3 !== undefined ? v3 : '');
    }
    push(el);
    if (!selfClosing && !VOID.has(tag)) stack.push(el);
  }
  return roots;
}

/** Finds the '>' that ends a tag, skipping any inside quoted attributes. */
function findTagEnd(src, start){
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

/* ---------------------------------------------------------------------------
   Document / window
   --------------------------------------------------------------------------- */
function makeDocument(){
  const doc = {
    _active: null,
    createElement(tag){ return new Element(tag, doc); },
    getElementById(id){ return doc.body.querySelector('#' + id); },
    querySelector(s){ return doc.body.querySelector(s); },
    querySelectorAll(s){ return doc.body.querySelectorAll(s); },
    addEventListener(){}, removeEventListener(){},
  };
  doc.body = new Element('body', doc);
  doc.documentElement = new Element('html', doc);
  return doc;
}

/**
 * Builds a sandbox holding the real admin globals.
 *
 * @param files  admin frontend files to evaluate, in <script> order.
 * @param shell  ids to create on <body> before evaluating (the panel expects
 *               #content, #toast-root, #modal-root, #side-nav to exist).
 */
function loadAdmin(files, shell = ['content', 'toast-root', 'modal-root', 'side-nav',
                                  'login-screen', 'app', 'topbar-username', 'topbar-userrole',
                                  'topbar-avatar', 'bell-badge']){
  const document = makeDocument();
  for (const id of shell) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }

  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  };

  const sandbox = {
    document,
    console,
    location: { hash: '' },
    localStorage: storage,
    sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, Date, JSON, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    Intl, FormData: class FormData { append(){} },
    fetch: async () => { throw new Error('fetch was not stubbed in this test'); },
    addEventListener(){}, removeEventListener(){},
    scrollTo(){},
    MutationObserver: class { observe(){} disconnect(){} },
    navigator: { userAgent: 'node-test' },
    AudioContext: undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  /* The panel's files declare their globals with `const` (const DB = …,
     const App = …). A top-level `const` is a lexical binding, NOT a property
     of globalThis, and every vm.runInContext call gets its own scope — so
     running the files separately would hide each file's globals from the
     next. Browsers share ONE global lexical environment across <script> tags,
     which concatenating reproduces. The epilogue then lifts the bindings onto
     the sandbox so tests can reach them, since `const` never would. */
  const sources = files.map(f => `/* ==== ${f} ==== */\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}`);
  const EXPORTS = ['Auth', 'NAV', 'App', 'DB', 'I', 'Modal', 'esc', 'toast', 'paginate',
    'pagerHTML', 'bindPager', 'statusBadge', 'debounce', 'PERM_GROUPS'];
  const epilogue = EXPORTS.map(n => `try{ if(typeof ${n} !== 'undefined') window.${n} = ${n}; }catch(e){}`).join('\n');

  vm.runInContext(sources.join('\n;\n') + '\n;\n' + epilogue, sandbox, { filename: 'admin-bundle.js' });
  return sandbox;
}

module.exports = { loadAdmin, makeDocument, parseHTML, matches, Element, TextNode, ROOT };
