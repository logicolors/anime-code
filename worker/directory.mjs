import {DurableObject} from 'cloudflare:workers';

// The list shows at most this many rooms, lobbies first, newest change first.
const LIST_MAX = 50;
const json = (status, value) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});

// One instance for the whole site. Each public room keeps one entry here, keyed
// by its code; rooms report changes themselves, so this object never asks them.
// An entry carries the room's own expiry bound, so a room that vanished without
// a word drops off on its own.
export class RoomDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = undefined;
  }
  async load() {
    if (!this.rooms) this.rooms = await this.ctx.storage.list();
    return this.rooms;
  }
  async fetch(request) {
    const url = new URL(request.url), rooms = await this.load(), now = Date.now();
    if (request.method === 'GET' && url.pathname === '/list') {
      const gone = [...rooms].filter(([, r]) => r.until <= now).map(([code]) => code);
      for (const code of gone) rooms.delete(code);
      // Storage deletes at most 128 keys per call.
      for (let i = 0; i < gone.length; i += 128) await this.ctx.storage.delete(gone.slice(i, i + 128));
      const list = [...rooms.values()].sort((a, b) => a.entry.playing - b.entry.playing || b.at - a.at).slice(0, LIST_MAX).map(r => r.entry);
      return json(200, {rooms:list});
    }
    if (request.method !== 'POST') return json(404, {error:'接口不存在。'});
    const {id, code, entry, until} = await request.json();
    if (url.pathname === '/put') {
      const value = {id, entry, until, at:now};
      rooms.set(code, value); await this.ctx.storage.put(code, value);
      return json(200, {ok:true});
    }
    // A code is reused after its room expires, so only that room's own entry is removed.
    if (url.pathname === '/remove') {
      if (rooms.get(code)?.id === id) { rooms.delete(code); await this.ctx.storage.delete(code); }
      return json(200, {ok:true});
    }
    return json(404, {error:'接口不存在。'});
  }
}
