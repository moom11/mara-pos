/*
  عامل الخدمة: يجعل الواجهة قابلة للتثبيت على الجوال، ولا يخزّن أي طلب API.

  لا نخزّن index.html ولا app.js ولا style.css. سبب ذلك أن التخزين كان
  لكل ملف على حدة: عند انقطاع الخادم لحظةً قد يصل ملف من الشبكة وآخر من
  الذاكرة، فتعمل صفحة قديمة بملف جديد فتنكسر الواجهة. ولا فائدة من نسخة
  تعمل بلا شبكة أصلًا — الواجهة بلا خادم لا تشغّل شيئًا.

  رقم النسخة يتغيّر مع كل تغيير هنا، فيمسح activate ما قبله تلقائيًا.
*/
const CACHE = 'mara-music-v2';
const SHELL = ['manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (event) => {
  // فشل تخزين الأيقونة لا يمنع التثبيت — وإلا بقي عامل خدمة قديم يعمل
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // الشبكة أولًا، والذاكرة للأيقونة والبيان فقط عند الانقطاع
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((cached) => cached || Response.error()))
  );
});
