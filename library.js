// Song library and practice log, kept on this device (IndexedDB). Every call fails soft:
// if storage is blocked the app still works, it just doesn't remember.
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const Lib = (() => {
  let dbp = null;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('piano-coach', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs'); // v1: only the last song
      if (!d.objectStoreNames.contains('library')) d.createObjectStore('library', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('days')) d.createObjectStore('days', { keyPath: 'date' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const tx = d.transaction(store, mode), q = fn(tx.objectStore(store));
    tx.oncomplete = () => res(q?.result);
    tx.onerror = () => rej(tx.error);
  }));
  const blank = () => ({ plays: 0, best: null, sections: {}, heat: {}, lastPlayed: 0, practiceSec: 0, mastery: 0 });
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fix = r => r && ({ ...r, settings: r.settings || {}, progress: { ...blank(), ...r.progress } });

  const Lib = {
    all: () => run('library', 'readonly', s => s.getAll()).then(l => l.map(fix)).catch(() => []),
    get: id => run('library', 'readonly', s => s.get(id)).then(fix).catch(() => null),
    put: r => run('library', 'readwrite', s => s.put(r)).catch(() => {}),
    remove: id => run('library', 'readwrite', s => s.delete(id)).catch(() => {}),
    // Importing the same file twice gives back the existing entry (with its progress).
    async add(name, buf) {
      const same = (await Lib.all()).find(r => r.name === name && r.buf?.byteLength === buf.byteLength);
      if (same) return same;
      const r = { id: newId(), name, buf, added: Date.now(), settings: {}, progress: blank() };
      await Lib.put(r);
      return r;
    },
    async demo() {
      let r = await Lib.get('demo');
      if (!r) {
        r = { id: 'demo', name: 'Demo: C major warm-up', demo: true, added: Date.now(), settings: {}, progress: blank() };
        await Lib.put(r);
      }
      return r;
    },
    async addTime(secs) {
      const date = dayKey();
      const cur = await run('days', 'readonly', s => s.get(date)).catch(() => null);
      await run('days', 'readwrite', s => s.put({ date, secs: (cur?.secs || 0) + secs })).catch(() => {});
    },
    days: () => run('days', 'readonly', s => s.getAll()).catch(() => []),
    // Version 1 only remembered the last opened song: move it into the library.
    async migrate() {
      const old = await run('songs', 'readonly', s => s.get('last')).catch(() => null);
      if (!old?.buf) return;
      await Lib.add(old.name.replace(/\.midi?$/i, ''), old.buf);
      await run('songs', 'readwrite', s => s.delete('last')).catch(() => {});
    },
  };
  return Lib;
})();
