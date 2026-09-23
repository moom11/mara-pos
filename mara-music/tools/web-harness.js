'use strict';

/*
  تشغيل واجهة الجوال (src/web/app.js) داخل Node مقابل الخادم الحقيقي.

  السبب: الواجهة كانت بلا اختبار واحد، فمرّ فيها خطأ يكسرها كاملةً عند كل
  دخول — متغيّر مُعرَّف داخل try واستُعمل خارجه — ولم يظهر إلا كشاشة سوداء
  على جوال صاحب المطعم. هذا الملف يبني متصفّحًا صغيرًا جدًا: عناصر وهمية
  بمعرّفات index.html نفسها، وfetch حقيقي إلى الخادم. فما يكسر الواجهة
  في الجوال يكسر الاختبار هنا.

  العناصر مأخوذة من index.html لا من قائمة مكتوبة يدويًا، فطلبُ عنصر غير
  موجود في الصفحة يعطي null هنا كما يعطيه المتصفّح تمامًا.
*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_DIR = path.join(__dirname, '..', 'src', 'web');

/**
 * العناصر كما وردت فعلًا في صفحة الواجهة، بحالة الإخفاء الابتدائية.
 * الحالة الابتدائية مهمّة: شاشات التطبيق تبدأ مخفية بسمة hidden في الصفحة،
 * ولو بدأت ظاهرة هنا لمرّت أخطاء "لم تُخفَ" أو "لم تظهر" دون أن يلحظها أحد.
 */
function elementsInHtml(html) {
  const found = new Map();
  for (const m of html.matchAll(/<([a-z0-9]+)([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const [, tag, attrs, id] = m;
    if (!found.has(id)) found.set(id, { tag, hidden: /\shidden(\s|=|$|>)/.test(attrs) });
  }
  return found;
}

function makeElement(id, tag) {
  const node = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    title: '',
    type: '',
    src: '',
    placeholder: '',
    checked: false,
    disabled: false,
    draggable: false,
    min: '',
    max: '',
    step: '',
    files: [],
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    onclick: null,
    oninput: null,
    onchange: null,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) {
        const want = on === undefined ? !this._set.has(c) : !!on;
        if (want) this._set.add(c); else this._set.delete(c);
        return want;
      }
    },
    appendChild(child) { node.children.push(child); return child; },
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
      return child;
    },
    remove() {},
    setAttribute(name, v) { node[name] = v; },
    getAttribute(name) { return node[name] === undefined ? null : String(node[name]); },
    addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    removeEventListener() {},
    // البحث في الأبناء يكفي للاختبار: الواجهة تستعمله لأزرار داخل عنصر واحد
    querySelectorAll(sel) { return node.children.filter((c) => matches(c, sel)); },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    focus() {},
    scrollIntoView() {},
    /** إطلاق حدث كما يفعل المتصفّح: الخاصية onX ثم المستمعون. */
    fire(type, event = {}) {
      const ev = { type, target: node, preventDefault() {}, stopPropagation() {}, ...event };
      const direct = node[`on${type}`];
      if (typeof direct === 'function') direct(ev);
      for (const fn of node.listeners[type] || []) fn(ev);
    }
  };
  return node;
}

function matches(node, sel) {
  const want = sel.trim().toLowerCase();
  if (want === '*') return true;
  return node.tagName.toLowerCase() === want;
}

/**
 * يشغّل app.js في بيئة وهمية موصولة بخادم حقيقي.
 * @param {object} opts
 * @param {string} opts.base عنوان الخادم، مثل http://127.0.0.1:8787
 * @param {string} [opts.token] رمز جلسة محفوظ مسبقًا (يحاكي فتح التطبيق ثانيةً)
 */
function loadWebApp({ base, token }) {
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const code = fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8');
  const found = elementsInHtml(html);
  const ids = new Set(found.keys());

  const nodes = new Map();
  for (const [id, info] of found) {
    const node = makeElement(id, info.tag);
    node.hidden = info.hidden;
    nodes.set(id, node);
  }

  const body = makeElement('', 'body');
  const storage = new Map();
  if (token) storage.set('mara.token', token);

  const errors = [];
  const timers = [];

  const document = {
    body,
    hidden: false,
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => makeElement('', tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null
  };

  const sandbox = {
    document,
    console,
    fetch: (url, init) => fetch(url.startsWith('http') ? url : base + url, init),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    location: { host: new URL(base).host, protocol: 'http:', origin: base, reload() {} },
    scrollTo() {},
    navigator: { userAgent: 'mara-web-harness' },
    // لا مؤقّتات حقيقية: الاختبار يقرّر متى ينفّذها، ولا تُبقي العملية حيّة
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
    confirm: () => true,
    prompt: () => 'اختبار',
    alert: () => {},
    FormData: class { append() {} },
    WebSocket: class {
      constructor(url) { this.url = url; this.readyState = 0; }
      send() {}
      close() { this.readyState = 3; }
    },
    URL,
    URLSearchParams,
    Response,
    encodeURIComponent,
    decodeURIComponent
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = (type, fn) => {
    if (type === 'error') sandbox.onError = fn;
    if (type === 'unhandledrejection') sandbox.onRejection = fn;
  };

  const context = vm.createContext(sandbox);
  // الذيل يكشف حالة الواجهة للاختبار: app و store معرّفان بـ const فلا
  // يصيران خصائص على الكائن العام من تلقاء نفسهما
  vm.runInContext(`${code}\n;globalThis.__mara = { app, store };`, context, {
    filename: 'src/web/app.js'
  });

  const harness = {
    ids,
    nodes,
    errors,
    timers,
    window: sandbox,
    $: (id) => nodes.get(id) || null,
    /** مفتاح من لوحة الأرقام المبنيّة فعلًا في الصفحة. */
    key(label) {
      const pad = nodes.get('keypad');
      const found = (pad ? pad.children : []).find((c) => c.dataset.key === String(label));
      if (!found) throw new Error(`لا يوجد مفتاح "${label}" في لوحة الأرقام`);
      return found;
    },
    /**
     * يدخل بالرمز عبر لوحة الأرقام تمامًا كما يفعل المستخدم:
     * يكتب الأرقام، وإن لم يُرسَل الرمز تلقائيًا ضغط مفتاح الدخول.
     */
    async login(pin) {
      const type = () => { for (const d of String(pin)) harness.key(d).fire('click'); };
      const answered = () => storage.has('mara.token') || harness.$('login-error').textContent;

      type();
      // ننتظر ردّ الإرسال التلقائي قبل أي محاولة ثانية: الواجهة ترفض
      // محاولة جديدة ما دامت الأولى في الطريق
      await harness.waitFor(answered);
      if (!storage.has('mara.token')) {
        // رمز أطول من أربعة أرقام: الإرسال التلقائي فشل، فنكتبه كاملًا وندخل
        harness.key('مسح').fire('click');
        type();
        harness.key('enter').fire('click');
        await harness.waitFor(answered);
      }
      await harness.settle();
    },
    get token() { return storage.get('mara.token') || null; },
    /** ينتظر تحقّق شرط، فنداءات الشبكة هنا حقيقية ولها زمن فعلي. */
    async waitFor(predicate, ms = 5000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return !!predicate();
    },
    /** ينتظر انتهاء ما أطلقته الواجهة من نداءات بعد آخر خطوة. */
    async settle(ms = 400) {
      await new Promise((r) => setTimeout(r, ms));
    }
  };
  return harness;
}

module.exports = { loadWebApp };
