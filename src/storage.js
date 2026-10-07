export class SessionStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.connection = null; }
  async open() {
    if (this.connection) return this.connection;
    if (!this.indexedDB) throw new Error('端末内保存（IndexedDB）を利用できません');
    this.connection = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open('respect-talk-sessions', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('他のタブを閉じて保存を再試行してください'));
    });
    return this.connection;
  }
  async run(mode, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', mode);
      const request = operation(transaction.objectStore('sessions'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || new Error('端末内保存に失敗しました'));
    });
  }
  save(session, recording = null) { return this.run('readwrite', (store) => store.put({ ...session, recording })); }
  list() { return this.run('readonly', (store) => store.getAll()).then((items) => items.sort((a, b) => b.startedAt - a.startedAt)); }
  delete(id) { return this.run('readwrite', (store) => store.delete(id)); }
}
