/* Service worker do Foco: cache offline + checagem de lembretes */
const CACHE = "foco-static-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== "foco-data").map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      event.waitUntil(fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      }).catch(() => {}));
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok && req.url.startsWith(self.location.origin)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch (e) {
      if (req.mode === "navigate") return caches.match("./index.html");
      throw e;
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all[0]) { all[0].focus(); return; }
    await self.clients.openWindow("./index.html");
  })());
});

async function readReminders() {
  try {
    const cache = await caches.open("foco-data");
    const keys = await cache.keys();
    const hit = keys.find((k) => k.url.indexOf("reminders-data.json") !== -1);
    if (!hit) return null;
    const res = await cache.match(hit);
    return res ? await res.json() : null;
  } catch (e) { return null; }
}

function pad(n) { return String(n).padStart(2, "0"); }
function todayKey(d) {
  const x = d || new Date();
  return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
}
function lastOccurrence(reminder, before) {
  const [hh, mm] = (reminder.time || "21:00").split(":").map(Number);
  const days = (reminder.days && reminder.days.length) ? reminder.days : [0,1,2,3,4,5,6];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(before.getFullYear(), before.getMonth(), before.getDate() - i, hh, mm, 0, 0);
    if (d.getTime() > before.getTime()) continue;
    if (days.indexOf(d.getDay()) !== -1) return d;
  }
  return null;
}

async function checkRemindersFromSW() {
  const data = await readReminders();
  if (!data || !data.reminders) return;
  const now = new Date();
  const windowMs = 3 * 60 * 60 * 1000;
  const lastShown = data.lastShown || {};
  for (const r of data.reminders) {
    if (!r.enabled) continue;
    const last = lastOccurrence(r, now);
    if (!last) continue;
    const ago = now.getTime() - last.getTime();
    if (ago < 0 || ago > windowMs) continue;
    const key = r.id + ":" + todayKey(last) + ":" + r.time;
    if (lastShown[key]) continue;
    const title = r.type === "journal" ? "Anotação do dia" : "Hora de focar";
    const body = r.message || (r.type === "journal" ? "Que tal escrever a anotação do dia?" : "Hora de estudar!");
    await self.registration.showNotification(title, { body, tag: "foco-rem-" + r.id, icon: "icon-192.png" });
  }
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "foco-reminder-check") event.waitUntil(checkRemindersFromSW());
});
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "reminders-updated") {
    event.waitUntil(checkRemindersFromSW());
  }
});
self.addEventListener("sync", (event) => {
  if (event.tag === "foco-reminder-check") event.waitUntil(checkRemindersFromSW());
});
