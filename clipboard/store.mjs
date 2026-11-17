import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_TEXT_BYTES = 1_000_000;
export const TTL_SECONDS = [600, 3600, 86400];
export const validRoom = (room) => typeof room === 'string' && /^(?:\d{6}|[A-Za-z0-9_-]{22})$/.test(room);
const roomHash = (room) => createHash('sha256').update(room).digest('hex');

export class PasteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class PasteStore {
  constructor(path = ':memory:', { now = Date.now, maxNotes = 1000, maxPerRoom = 25 } = {}) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.maxNotes = maxNotes;
    this.maxPerRoom = maxPerRoom;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, room_hash TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_room ON notes(room_hash, created_at);
      CREATE INDEX IF NOT EXISTS notes_expiry ON notes(expires_at);`);
    if (!this.db.prepare('PRAGMA table_info(notes)').all().some(column => column.name === 'subject')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
    }
  }

  purge() { this.db.prepare('DELETE FROM notes WHERE expires_at <= ?').run(this.now()); }

  list(room) {
    if (!validRoom(room)) throw new PasteError('Tautan ruang tidak valid.');
    this.purge();
    return this.db.prepare('SELECT id, subject, text, created_at AS createdAt, expires_at AS expiresAt FROM notes WHERE room_hash = ? ORDER BY created_at DESC, id DESC')
      .all(roomHash(room)).map((note) => ({ ...note }));
  }

  add(room, text, ttl = 3600, subject = '') {
    if (!validRoom(room)) throw new PasteError('Tautan ruang tidak valid.');
    if (typeof text !== 'string' || !text.trim()) throw new PasteError('Masukkan teks terlebih dahulu.');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new PasteError('Teks terlalu panjang. Maksimal 1 MB.', 413);
    if (!TTL_SECONDS.includes(ttl)) throw new PasteError('Masa berlaku tidak valid.');
    if (typeof subject !== 'string' || [...subject.trim()].length > 120) throw new PasteError('Subject maksimal 120 karakter.');
    this.purge();
    const hash = roomHash(room);
    const count = this.db.prepare('SELECT count(*) AS total FROM notes WHERE room_hash = ?').get(hash).total;
    if (count >= this.maxPerRoom) throw new PasteError('Ruang penuh. Hapus salah satu teks terlebih dahulu.', 409);
    if (this.db.prepare('SELECT count(*) AS total FROM notes').get().total >= this.maxNotes) {
      throw new PasteError('Papan teks sedang penuh. Coba lagi nanti.', 503);
    }
    const createdAt = this.now();
    const number = Math.max(0, ...this.db.prepare('SELECT subject FROM notes WHERE room_hash = ?').all(hash)
      .map(note => Number(/^Memo (\d+)$/.exec(note.subject)?.[1] || 0)));
    const note = { id: randomUUID(), subject: subject.trim() || `Memo ${number + 1}`, text, createdAt, expiresAt: createdAt + ttl * 1000 };
    this.db.prepare('INSERT INTO notes (id, room_hash, subject, text, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(note.id, hash, note.subject, text, note.createdAt, note.expiresAt);
    return note;
  }

  remove(room, id) {
    if (!validRoom(room)) throw new PasteError('Tautan ruang tidak valid.');
    this.db.prepare('DELETE FROM notes WHERE room_hash = ? AND id = ?').run(roomHash(room), id);
  }

  etag(notes) { return `"${createHash('sha256').update(JSON.stringify(notes.map((note) => [note.id, note.subject, note.expiresAt]))).digest('hex').slice(0, 24)}"`; }
  close() { this.db.close(); }
}
