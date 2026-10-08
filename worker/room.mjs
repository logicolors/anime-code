import {DurableObject} from 'cloudflare:workers';
import core from '../room-core.js';

// Terminal close codes: the client clears its session and shows the reason.
const IDENTITY = 4003, EXPIRED = 4004;
// A socket that has not answered a ping for this long is treated as closed.
const ZOMBIE_MS = 60000;
const MAX_MESSAGE = 16384;
// Chat per player, across their tabs: this many messages per window.
const CHAT_BURST = 5, CHAT_WINDOW_MS = 5000;
// A public room's directory entry carries its expiry; it is refreshed once the
// expiry has moved on by this much, not on every action.
const LISTING_REFRESH_MS = 30*60*1000;
const json = (status, value) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
const close = (ws, code, reason) => { try { ws.close(code, reason); } catch {} };
const send = (ws, text) => { try { ws.send(text); } catch {} };

// One instance per room code. The room lives in memory and in one storage key;
// every event runs through one promise chain, so changes apply strictly in order.
export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the platform without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    core.configure({graceMs:Number(env.GRACE_MS) || undefined, turnSeconds:Number(env.TEST_TURN_SECONDS) || undefined});
    // Browser tests pin the deal so the first team and the map are known.
    this.random = env.TEST_RANDOM ? () => Number(env.TEST_RANDOM) : Math.random;
    this.room = undefined; this.queue = Promise.resolve(); this.chatRate = new Map(); this.reports = Promise.resolve();
  }
  run(fn) {
    const next = this.queue.then(() => this.step(fn));
    this.queue = next.catch(() => {});
    return next;
  }
  // Load, apply what time alone has changed, then the event itself. Anything that
  // changed is persisted before it is broadcast.
  async step(fn) {
    if (this.room === undefined) this.room = (await this.ctx.storage.get('room')) ?? null;
    const now = Date.now(), ctx = {now, changed:false, save:false, after:null, departed:new Map()};
    if (this.room) ctx.changed = core.due(this.room, now) | this.sync(now);
    const value = await fn(ctx);
    const room = this.room;
    if (room && core.expired(room, now)) {
      ctx.after?.();
      await this.expire();
      return value;
    }
    const update = room && this.listing(room);
    if (room && ctx.changed) {
      room.version++;
      await this.ctx.storage.put('room', room);
      this.broadcast(now);
    } else if (room && (ctx.save || update)) await this.ctx.storage.put('room', room);
    ctx.after?.();
    this.report(update);
    if (room) this.evict(ctx.departed);
    await this.reconcileAlarm(now);
    return value;
  }
  sockets() { return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN); }
  // Recomputes who is connected. Any event is a chance to spot a socket the
  // platform never reported closed: no pong for a minute means it is gone, and
  // the player dropped when it last answered.
  sync(now, closing = null) {
    const ids = new Set(), since = {};
    for (const ws of this.sockets()) {
      if (ws === closing) continue;
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, a.at ?? 0);
      if (now - last > ZOMBIE_MS) {
        if (a.playerId) since[a.playerId] = Math.max(since[a.playerId] ?? 0, last);
        close(ws, 1011, 'stale'); continue;
      }
      if (a.playerId) ids.add(a.playerId);
    }
    for (const id of ids) delete since[id];
    return core.presence(this.room, ids, now, since);
  }
  message(player, now) {
    const room = this.room;
    return JSON.stringify({type:'state', roomId:room.id, version:room.version, serverNow:now, state:core.snapshot(room, player, now)});
  }
  broadcast(now) {
    const cache = new Map();
    for (const ws of this.sockets()) {
      const id = ws.deserializeAttachment()?.playerId; if (!id) continue;
      const player = this.room.players.find(p => p.id === id); if (!player) continue;
      if (!cache.has(id)) cache.set(id, this.message(player, now));
      send(ws, cache.get(id));
    }
  }
  // Sockets of players who are no longer in the room are closed for good.
  evict(departed) {
    for (const ws of this.sockets()) {
      const id = ws.deserializeAttachment()?.playerId;
      if (!id || this.room.players.some(p => p.id === id)) continue;
      const [code, reason] = departed.get(id) || [IDENTITY, '身份已失效，请重新加入房间。'];
      close(ws, code, reason);
    }
  }
  // What the directory should hear, if anything. `room.listed` keeps what was
  // last sent, so a wake or an unrelated change sends nothing.
  listing(room) {
    const entry = core.listing(room), last = room.listed ?? null;
    if (!entry) {
      if (!last) return null;
      room.listed = null;
      return {path:'/remove', body:{id:room.id, code:room.code}, sent:null};
    }
    const key = JSON.stringify(entry), until = room.touched + core.options.idleMs;
    if (last && last.key === key && until - last.until < LISTING_REFRESH_MS) return null;
    room.listed = {key, until};
    return {path:'/put', body:{id:room.id, code:room.code, entry, until}, sent:room.listed};
  }
  // Reports run in order, off the room's own chain, so the list never holds up play.
  // A failed one marks the room unsent, and its next event tries again.
  report(update) {
    if (!update) return;
    const room = this.room;
    this.reports = this.reports.then(() => this.directory(update.path, update.body)).catch(error => {
      console.error('directory update failed', error);
      if (room.listed === update.sent) room.listed = {key:null, until:0};
    });
  }
  async directory(path, body) {
    const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory'));
    const response = await stub.fetch(`https://directory${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!response.ok) throw new Error(`directory answered ${response.status}`);
  }
  async expire() {
    for (const ws of this.ctx.getWebSockets()) close(ws, EXPIRED, '房间已过期或已解散。');
    if (this.room?.listed) await this.directory('/remove', {id:this.room.id, code:this.room.code}).catch(error => console.error('directory remove failed', error));
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
  // One alarm, never in the past. It is only moved earlier: an alarm that fires
  // before anything is due just schedules the next one, which saves a write per action.
  async reconcileAlarm(now) {
    const current = await this.ctx.storage.getAlarm();
    if (!this.room) { if (current != null) await this.ctx.storage.deleteAlarm(); return; }
    const at = Math.max(core.nextWake(this.room), now + 1000);
    if (current == null || at < current || current < now) await this.ctx.storage.setAlarm(at);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json(426, {error:'需要 WebSocket 连接。'});
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      // A socket carries no identity until its hello arrives.
      server.serializeAttachment({playerId:null, at:Date.now()});
      return new Response(null, {status:101, webSocket:client});
    }
    if (request.method !== 'POST' || !['/create', '/join'].includes(url.pathname)) return json(404, {error:'接口不存在。'});
    const input = await request.json();
    return this.run(ctx => {
      try {
        let player;
        if (url.pathname === '/create') {
          if (this.room) return json(409, {error:'房间号已被占用。'});
          ({room:this.room, player} = core.createRoom({code:input.code, id:crypto.randomUUID(), name:input.name, dataDate:input.dataDate, now:ctx.now, client:input.client}));
        } else {
          if (!this.room) return json(404, {error:'找不到这个房间，请检查六位房间号。'});
          player = core.join(this.room, input.name, ctx.now, input.client);
        }
        ctx.changed = true;
        // The version this response is built with is the one the broadcast will carry.
        return json(200, {code:this.room.code, token:player.token, state:core.snapshot(this.room, player, ctx.now)});
      } catch (error) { return json(400, {error:error.message}); }
    });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') return this.run(ctx => this.hello(ws, msg, ctx));
    if (msg.type === 'action') return this.run(ctx => this.action(ws, msg, ctx));
    if (msg.type === 'chat') return this.run(ctx => this.chat(ws, msg, ctx));
  }
  hello(ws, msg, ctx) {
    if (!this.room) return close(ws, EXPIRED, '房间不存在或已过期，请重新创建或加入。');
    const player = typeof msg.token === 'string' && this.room.players.find(p => p.token === msg.token);
    if (!player) return close(ws, IDENTITY, '身份已失效，请重新加入房间。');
    ws.serializeAttachment({playerId:player.id, at:ctx.now});
    this.room.touched = ctx.now; ctx.save = true;
    if (this.sync(ctx.now)) ctx.changed = true;
    // A hello always gets the current state: from the broadcast when something
    // changed, otherwise on its own.
    ctx.after = () => { if (!ctx.changed) send(ws, this.message(player, ctx.now)); };
  }
  action(ws, msg, ctx) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
    const reply = value => send(ws, JSON.stringify({type:'result', id, ...value}));
    const playerId = ws.deserializeAttachment()?.playerId;
    const player = this.room?.players.find(p => p.id === playerId);
    if (!player) { ctx.after = () => reply({ok:false, error:'连接尚未就绪，请稍后重试。'}); return; }
    const {type, id:_, ...input} = msg;
    try {
      const result = core.action(this.room, player, input, ctx.now, this.random);
      ctx.changed = true;
      if (input.action === 'kick') ctx.departed.set(input.player, [IDENTITY, '你已被房主移出房间']);
      if (result.left) ctx.departed.set(player.id, [IDENTITY, '你已离开房间。']);
      // The result follows the broadcast, so the new state is in place when it resolves.
      ctx.after = () => reply(result.left ? {ok:true, left:true} : {ok:true});
    } catch (error) {
      ctx.after = () => reply({ok:false, error:error.message});
    }
  }
  // A chat line goes straight to the sockets of whoever may hear it. It is not
  // part of the room state, so it moves no version and is never stored; only the
  // room's idle clock is saved, at most once a minute.
  chat(ws, msg, ctx) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
    const reply = value => send(ws, JSON.stringify({type:'result', id, ...value}));
    const playerId = ws.deserializeAttachment()?.playerId;
    const player = this.room?.players.find(p => p.id === playerId);
    if (!player) { ctx.after = () => reply({ok:false, error:'连接尚未就绪，请稍后重试。'}); return; }
    const rate = this.chatRate.get(player.id);
    if (rate && ctx.now - rate.since < CHAT_WINDOW_MS && rate.count >= CHAT_BURST) { ctx.after = () => reply({ok:false, error:'发送得太快，请稍后再试。'}); return; }
    if (!rate || ctx.now - rate.since >= CHAT_WINDOW_MS) this.chatRate.set(player.id, {since:ctx.now, count:1}); else rate.count++;
    try {
      const idle = ctx.now - this.room.touched >= 60000;
      const {message, to} = core.chat(this.room, player, msg, ctx.now);
      if (idle) ctx.save = true;
      const text = JSON.stringify({type:'chat', message}), ids = new Set(to);
      ctx.after = () => {
        for (const target of this.sockets()) if (ids.has(target.deserializeAttachment()?.playerId)) send(target, text);
        reply({ok:true});
      };
    } catch (error) {
      ctx.after = () => reply({ok:false, error:error.message});
    }
  }
  async webSocketClose(ws) {
    close(ws, 1000, 'closed');
    await this.run(ctx => { if (this.room && this.sync(ctx.now, ws)) ctx.changed = true; });
  }
  async webSocketError(ws) {
    await this.run(ctx => { if (this.room && this.sync(ctx.now, ws)) ctx.changed = true; });
  }
  async alarm(info) {
    // The step itself applies the deadline, the grace boundaries and the expiry.
    try { await this.run(() => {}); }
    catch (error) { if ((info?.retryCount ?? 0) < 3) throw error; console.error('alarm failed', error); }
  }
}
