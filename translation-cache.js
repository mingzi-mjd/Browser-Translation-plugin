globalThis.TranslationCache = (() => {
  const TTL = 30 * 24 * 60 * 60 * 1000, LIMIT = 10000;
  let dbPromise, revision = 0;
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("translation-local-cache", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("translations", { keyPath: "key" });
        store.createIndex("expiresAt", "expiresAt");
        store.createIndex("lastUsed", "lastUsed");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { dbPromise = null; reject(new Error("无法打开本地翻译缓存")); };
    });
    return dbPromise;
  }
  async function transaction(mode, work) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("translations", mode);
      const output = {};
      tx.oncomplete = () => resolve(output.value);
      tx.onabort = tx.onerror = () => reject(new Error("本地缓存操作失败"));
      try { work(tx.objectStore("translations"), output); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  function purge(store) {
    const request = store.index("expiresAt").openCursor(IDBKeyRange.upperBound(Date.now()));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
  }
  async function hash(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async function keys(engine, target, texts, config) {
    // No API keys are included in either the fingerprint or stored records.
    const signature = config ? [
      config.baseUrl, config.model, config.systemPrompt,
      config.sendTemperature ? config.temperature : "default", config.maxTokens
    ] : [];
    const fingerprint = await hash(JSON.stringify(["translation-v2", engine, target, signature]));
    return Promise.all(texts.map(text => hash(JSON.stringify([fingerprint, text.trim()]))));
  }
  async function get(keys) {
    return transaction("readwrite", (store, out) => {
      const now = Date.now(); out.value = Array(keys.length).fill(null);
      purge(store);
      keys.forEach((key, index) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const row = request.result;
          if (row && row.expiresAt > now) {
            out.value[index] = row.translation;
            row.lastUsed = now; store.put(row);
          }
        };
      });
    });
  }
  async function put(records, expectedRevision) {
    if (expectedRevision !== revision) return;
    return transaction("readwrite", store => {
      if (expectedRevision !== revision) return;
      const now = Date.now();
      purge(store);
      for (const record of records) {
        // Bound output sizes as well as entry count.
        if (record.translation.length <= 64000) store.put({ ...record, createdAt: now, lastUsed: now, expiresAt: now + TTL });
      }
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - LIMIT;
        if (excess <= 0) return;
        const oldest = store.index("lastUsed").openCursor();
        oldest.onsuccess = () => {
          const cursor = oldest.result;
          if (cursor && excess-- > 0) { cursor.delete(); cursor.continue(); }
        };
      };
    });
  }
  async function list(offset = 0) {
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    return transaction("readwrite", (store, out) => {
      out.value = { total: 0, rows: [], limit: LIMIT, days: 30 };
      // Count/list only live entries, without loading all source text into memory.
      let valid = 0;
      const request = store.index("lastUsed").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { out.value.total = valid; return; }
        const row = cursor.value;
        if (row.expiresAt <= Date.now()) cursor.delete();
        else {
          if (valid >= offset && out.value.rows.length < 30) out.value.rows.push(row);
          valid++;
        }
        cursor.continue();
      };
    });
  }
  async function clear() {
    revision++;
    return transaction("readwrite", store => { store.clear(); });
  }
  async function remove(key) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("缓存记录无效");
    revision++;
    return transaction("readwrite", store => { store.delete(key); });
  }
  return { keys, get, put, list, clear, remove, revision: () => revision, invalidate: () => { revision++; } };
})();
