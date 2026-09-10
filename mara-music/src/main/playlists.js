'use strict';

const crypto = require('crypto');
const { readJSON, writeJSON } = require('./store');

const ALL_TRACKS_ID = '__all__';

class Playlists {
  constructor(library) {
    this.library = library;
    this.items = new Map();
  }

  load() {
    const saved = readJSON('playlists', { playlists: [] });
    for (const p of saved.playlists || []) {
      if (p && p.id) this.items.set(p.id, p);
    }
  }

  persist() {
    writeJSON('playlists', { playlists: [...this.items.values()] });
  }

  list() {
    const all = {
      id: ALL_TRACKS_ID,
      name: 'كل الأغاني',
      builtin: true,
      count: this.library.tracks.size,
      updatedAt: this.library.lastScanAt
    };
    const rest = [...this.items.values()]
      .map((p) => ({ ...p, count: p.trackIds.length }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return [all, ...rest];
  }

  get(id) {
    if (id === ALL_TRACKS_ID) {
      return { id: ALL_TRACKS_ID, name: 'كل الأغاني', builtin: true, trackIds: this.libraryTrackIds() };
    }
    return this.items.get(id) || null;
  }

  libraryTrackIds() {
    return this.library
      .search('', { limit: Number.MAX_SAFE_INTEGER, sort: 'title' })
      .items.map((t) => t.id);
  }

  trackIdsOf(id) {
    const pl = this.get(id);
    if (!pl) return [];
    return pl.builtin ? pl.trackIds : pl.trackIds.filter((tid) => this.library.tracks.has(tid));
  }

  create(name) {
    const id = crypto.randomBytes(6).toString('hex');
    const pl = { id, name: String(name || 'قائمة جديدة').trim(), trackIds: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.items.set(id, pl);
    this.persist();
    return pl;
  }

  rename(id, name) {
    const pl = this.items.get(id);
    if (!pl) return null;
    pl.name = String(name).trim() || pl.name;
    pl.updatedAt = Date.now();
    this.persist();
    return pl;
  }

  remove(id) {
    const ok = this.items.delete(id);
    if (ok) this.persist();
    return ok;
  }

  addTracks(id, trackIds) {
    const pl = this.items.get(id);
    if (!pl) return null;
    for (const tid of trackIds) {
      if (this.library.tracks.has(tid) && !pl.trackIds.includes(tid)) pl.trackIds.push(tid);
    }
    pl.updatedAt = Date.now();
    this.persist();
    return pl;
  }

  removeTrack(id, trackId) {
    const pl = this.items.get(id);
    if (!pl) return null;
    pl.trackIds = pl.trackIds.filter((tid) => tid !== trackId);
    pl.updatedAt = Date.now();
    this.persist();
    return pl;
  }

  reorder(id, from, to) {
    const pl = this.items.get(id);
    if (!pl) return null;
    if (from < 0 || from >= pl.trackIds.length || to < 0 || to >= pl.trackIds.length) return pl;
    const [moved] = pl.trackIds.splice(from, 1);
    pl.trackIds.splice(to, 0, moved);
    pl.updatedAt = Date.now();
    this.persist();
    return pl;
  }

  setTracks(id, trackIds) {
    const pl = this.items.get(id);
    if (!pl) return null;
    pl.trackIds = trackIds.filter((tid) => this.library.tracks.has(tid));
    pl.updatedAt = Date.now();
    this.persist();
    return pl;
  }
}

module.exports = { Playlists, ALL_TRACKS_ID };
