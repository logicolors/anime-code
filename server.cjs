'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const G = require('./game.js');
const {WebSocketServer, WebSocket} = require('ws');

const fail = message => { throw new Error(message); };
const votingRules = ['majority','unanimous','any'];
// Votes needed to execute a guess, shared by the snapshot threshold and the vote path.
const required = (voting, guessers) => voting === 'any' ? 1 : voting === 'unanimous' ? guessers : Math.floor(guessers/2)+1;
class Rooms {
  // `changed` is called with a room whenever its shared state moves, so the
  // transport can nudge the members instead of leaving them to poll blind.
  constructor(data, {now = Date.now, random = Math.random, changed = () => {}} = {}) {
    this.data = data; this.now = now; this.random = random; this.changed = changed; this.rooms = new Map();
  }
  // Readiness is the player's own statement, so joins, seat moves and pool or
  // rule edits leave it alone. It only clears when the seat is empty, the player
  // drops offline, or the room comes back to the lobby for a fresh round.
  reset(r) { r.game = null; r.votes = {}; r.epoch++; for (const p of r.players) {p.ready = false; p.returned = false;} }
  // A finished match is a review screen, not a lock on the room: each player
  // leaves it on their own. Until they do, they hold no lobby seat, so the ones
  // who already came back can re-seat and get ready without waiting.
  inLobby(r, p) { return !r.game || p.returned; }
  // An offline player is not reading the map, so they never stall the others'
  // way back to the lobby; the reset clears their flag for when they reconnect.
  reviewing(r) { return !!r.game && r.players.some(p => !p.returned && p.online); }
  // Called wherever a player's return may have been the last one outstanding.
  settle(r) { if (r.game && r.game.phase === 'over' && !this.reviewing(r)) this.reset(r); }
  sweep() {
    for (const [code, r] of this.rooms) {
      // Nobody asked for these changes, so they are the ones most worth pushing:
      // without a nudge the room only learns about them on its next poll.
      let moved = false;
      for (const p of r.players) if (p.online && this.now() - p.seen > 12000) {
        p.online = false; p.ready = false; moved = true;
      }
      if (!r.players.some(p => p.id === r.host && p.online)) {
        const next = r.players.find(p => p.online); if (next) {r.host = next.id; moved = true;}
      }
      // The player who dropped may have been the last one still on the map.
      const game = r.game; this.settle(r); if (r.game !== game) moved = true;
      if (this.now() - r.touched > 2 * 60 * 60 * 1000) {this.rooms.delete(code); continue;}
      if (moved) this.changed(r);
    }
  }
  auth(code, token) {
    this.sweep();
    const r = this.rooms.get(code); if (!r) fail('房间不存在或已过期，请重新创建或加入。');
    const p = r.players.find(p => p.token === token); if (!p) fail('身份已失效，请重新加入房间。');
    // Coming back online is a change the rest of the room needs to see.
    if (!p.online) {p.online = true; this.changed(r);}
    p.seen = r.touched = this.now(); return {r, p};
  }
  enter(input) {
    this.sweep();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 20) fail('昵称需要 1–20 个字符。');
    let r;
    if (input.action === 'create') {
      if (this.rooms.size >= 200) fail('房间数量已达上限。');
      let code; do { code = String(crypto.randomInt(100000, 1000000)); } while (this.rooms.has(code));
      r = {code, codeHidden:false, host:null, players:[], settings:{filters:{...G.defaults, excluded:[...G.defaults.excluded], included:[]}, voting:'unanimous', rules:{...G.ruleDefaults}}, poolCount:0, game:null, votes:{}, epoch:0, touched:this.now()};
      r.poolCount = G.filter(this.data, r.settings.filters).length; this.rooms.set(code, r);
    } else {
      r = this.rooms.get(String(input.code)); if (!r) fail('找不到这个房间，请检查六位房间号。');
      // A finished match is only a review screen, so a newcomer can take a lobby
      // seat straight away; a live match still cannot absorb one.
      if (r.game && r.game.phase !== 'over') fail('房间正在对局中，请等本局结束后加入。');
      if (r.players.length >= 16) fail('房间已满（最多 16 人）。');
    }
    const p = {id:crypto.randomUUID(), token:crypto.randomBytes(32).toString('hex'), name, codeHidden:null, team:null, role:'guesser', ready:false, returned:!!r.game, online:true, seen:this.now()};
    r.players.push(p); r.host ||= p.id; r.touched = this.now();
    this.changed(r);
    return {token:p.token, state:this.snapshot(r, p)};
  }
  blockers(r) {
    const issues = [];
    // A player still on the review screen holds no lobby seat yet, so their old
    // match team must not satisfy a seat requirement for the next round.
    const seated = r.players.filter(p => this.inLobby(r, p));
    if (this.reviewing(r)) issues.push('等待其他玩家返回大厅');
    for (const team of ['red','blue']) {
      if (!seated.some(p => p.team === team && p.role === 'captain')) issues.push(`${G.label(team)}缺少队长`);
      if (!seated.some(p => p.team === team && p.role === 'guesser')) issues.push(`${G.label(team)}至少需要一名猜词人`);
    }
    if (seated.some(p => !p.team)) issues.push('还有玩家未选位置');
    if (r.players.some(p => !p.online)) issues.push('等待离线玩家重连，或由房主移除');
    if (seated.some(p => !p.ready)) issues.push('等待全员准备');
    return issues;
  }
  snapshot(r, p) {
    let game = null;
    // Returning to the lobby ends this player's review even while others read on.
    if (r.game && !p.returned) {
      const g = r.game, canSee = p.role === 'captain' || g.phase === 'over';
      // The ban is a captains-only signal: the guessers still have to read the
      // clue, not a warning label on the board. Once the card is turned over the
      // ban is no secret any more: the tile keeps it, and everyone sees its mark.
      game = {...g, banned:Object.fromEntries(['red','blue'].map(team => {const i = g.banned?.[team] ?? null; return [team, canSee || g.tiles[i]?.revealed ? i : null];})), remaining:{red:G.remaining(g,'red'), blue:G.remaining(g,'blue')}, tiles:g.tiles.map(t => ({anime:{id:t.anime.id,name_cn:G.name(t.anime),image_url:t.anime.image_url,air_date:t.anime.air_date,score:t.anime.score,vote_count:t.anime.vote_count}, revealed:t.revealed, ...(canSee || t.revealed ? {type:t.type} : {}), ...(t.bannedBy ? {bannedBy:t.bannedBy} : {})}))};
    }
    const eligible = r.players.filter(p => p.team === r.game?.turn && p.role === 'guesser');
    return {code:r.code, codeHidden:p.id===r.host?r.codeHidden:(p.codeHidden??r.codeHidden), host:r.host, me:p.id, players:r.players.map(({token,seen,codeHidden,returned,...rest}) => ({...rest, inMatch:!!r.game && !returned})), settings:r.settings, poolCount:r.poolCount, epoch:r.epoch, game, votes:r.votes, threshold:required(r.settings.voting, eligible.length), blockers:this.blockers(r)};
  }
  action(code, token, a) {
    const {r,p} = this.auth(code,token);
    const host = () => { if (p.id !== r.host) fail('只有房主可以进行此操作。'); };
    const lobby = () => { if (!this.inLobby(r, p)) fail('请先返回大厅再调整。'); };
    switch (a.action) {
      case 'codeVisibility':
        if (typeof a.hidden !== 'boolean') fail('房间号显示设置无效。');
        // Members follow the room default until they choose their own visibility.
        // Keep that default on host transfer so a hidden code stays hidden.
        if (p.id === r.host) {r.codeHidden = a.hidden; p.codeHidden = null;}
        else p.codeHidden = a.hidden;
        break;
      case 'seat': {
        lobby(); if (![null,'red','blue'].includes(a.team) || !['captain','guesser'].includes(a.role)) fail('位置无效。');
        // Only players who are actually in the lobby hold a seat, so a captain
        // still reading the finished map does not block the chair.
        if (a.team && a.role === 'captain' && r.players.some(q => q.id !== p.id && this.inLobby(r,q) && q.team === a.team && q.role === 'captain')) fail('该队已经有队长，请先让出位置。');
        p.team = a.team; p.role = a.role; if (!p.team) p.ready = false; break;
      }
      case 'ready':
        lobby(); if (!p.team) fail('请先选择队伍和位置。');
        p.ready = a.ready === true; break;
      case 'settings': {
        host(); lobby(); const f = {...r.settings.filters,...(a.filters || {})};
        // Year bounds stop at the dataset cutoff; later years match nothing anyway.
        const integerLimits = {minVotes:[0,100000000],minYear:[0,G.dataYear],maxYear:[1996,G.dataYear]};
        for (const [key,[min,max]] of Object.entries(integerLimits)) if (!Number.isInteger(f[key]) || f[key]<min || f[key]>max) fail('筛选数值无效。');
        for (const key of ['minScore','maxScore']) {
          // Scores use Bangumi's 0–10 scale with a 0.1 step; compare the step with a
          // tolerance because values like 8.3*10 land on 83.00000000000001.
          if (typeof f[key] !== 'number' || !Number.isFinite(f[key]) || f[key]<0 || f[key]>10 || Math.abs(Math.round(f[key]*10)-f[key]*10)>1e-6) fail('筛选数值无效。');
        }
        if (f.minYear>f.maxYear || f.minScore>f.maxScore) fail('筛选范围无效。');
        const validTags = list => Array.isArray(list) && list.length<=100 && list.every(t=>typeof t==='string' && t.trim()===t && t.length>0 && t.length<=30) && new Set(list).size===list.length;
        for (const key of ['excluded','included']) if (!validTags(f[key])) fail('标签筛选无效。');
        for (const key of ['excludeOptions','includeOptions']) if (Object.hasOwn(f,key) && !validTags(f[key])) fail('标签列表无效。');
        const voting = a.voting || r.settings.voting; if (!votingRules.includes(voting)) fail('投票规则无效。');
        // Optional rules arrive as a patch, so a client that only knows about the
        // voting rule keeps the rest of the room's choices intact.
        const rules = {...r.settings.rules,...(a.rules || {})};
        if (!G.flipModes.includes(rules.maxFlips)) fail('翻牌上限设置无效。');
        for (const key of ['freeCount','ban']) if (typeof rules[key] !== 'boolean') fail('规则设置无效。');
        const count = G.filter(this.data,f).length; if (count<25) fail('牌池至少需要 25 部动画。');
        r.settings = {filters:{...f,excluded:[...f.excluded],included:[...f.included],excludeOptions:[...(f.excludeOptions||G.excludedTags)],includeOptions:[...(f.includeOptions||[])]},voting,rules:{maxFlips:rules.maxFlips,freeCount:rules.freeCount,ban:rules.ban}}; r.poolCount = count; break;
      }
      case 'start':
        host(); lobby(); if (this.blockers(r).length) fail(this.blockers(r).join('；'));
        r.game = G.create(G.filter(this.data,r.settings.filters),this.random,this.random()<0.5?'red':'blue',r.settings.rules); r.votes = {}; r.epoch++;
        for (const q of r.players) q.returned = false;
        break;
      // Reviewing the finished map is each player's own business: they leave it
      // one by one and the room only resets once the last one is out. An
      // unfinished match is still shared, so the host ends it for everyone.
      case 'lobby':
        if (!r.game) break;
        if (r.game.phase !== 'over') { host(); this.reset(r); break; }
        p.returned = true; p.ready = false; r.epoch++;
        this.settle(r);
        break;
      case 'kick': {
        host(); const target = r.players.find(q => q.id === a.player);
        if (!target || target.online) fail('只能移除离线玩家。');
        r.players = r.players.filter(q => q !== target); this.reset(r); break;
      }
      case 'leave':
        r.players = r.players.filter(q => q !== p);
        // Leaving during a live match ends it for everyone; leaving the review
        // screen is just one more player walking out of it.
        if (r.game?.phase === 'over') this.settle(r); else this.reset(r);
        if (!r.players.length) this.rooms.delete(r.code);
        else if (r.host === p.id) r.host = (r.players.find(q => q.online) || r.players[0]).id;
        this.changed(r);
        return {left:true};
      case 'clue': case 'vote': case 'ban': {
        const g = r.game; if (!g || g.phase === 'over') fail('当前没有进行中的对局。');
        if (a.epoch !== r.epoch) fail('牌局已更新，请按最新状态重新操作。');
        if (p.team !== g.turn) fail('现在不是你的队伍回合。');
        // Banning a card leaves the turn where it is, so it does not move the
        // epoch: the captain still publishes their clue from the same snapshot.
        if (a.action === 'ban') {
          if (!r.settings.rules.ban) fail('本局没有开启队长禁牌。');
          if (p.role !== 'captain') fail('仅当轮队长可以禁牌。');
          if (g.phase !== 'clue') fail('只能在出题阶段禁牌。');
          if (a.index !== null && (!Number.isInteger(a.index) || !g.tiles[a.index] || g.tiles[a.index].revealed)) fail('请选择一张尚未翻开的牌。');
          if (a.index !== null && g.banned?.[G.other(g.turn)] === a.index) fail('这张牌已被对方禁用。');
          if (!G.ban(g,a.index)) fail('禁牌无效。');
          break;
        }
        if (a.action === 'clue') {
          if (p.role !== 'captain') fail('仅当轮队长可以发布提示。');
          if (typeof a.word !== 'string') fail('提示词必须是文本。');
          const word = a.word.trim();
          if (!word) fail('提示词不能为空。');
          if (word.length > 30) fail('提示词最多 30 个字符。');
          if (/\s/.test(word)) fail('提示词不能包含空格。');
          // A missing number is the "flip as many as you like" clue, and only the
          // rooms that allow it accept one.
          const blank = a.count === null || a.count === undefined;
          if (blank && !r.settings.rules.freeCount) fail('本局必须填写提示张数。');
          if (!blank) {
            if (!Number.isInteger(a.count)) fail('提示张数必须是整数。');
            if (a.count < 0) fail('提示张数不能为负数。');
          }
          if (!G.giveClue(g,word,blank ? null : a.count)) fail('提示无效，请检查提示词和张数。');
          r.epoch++; r.votes = {}; break;
        }
        if (p.role !== 'guesser' || g.phase !== 'guess') fail('仅当轮猜词人可以投票。');
        const choice = a.choice;
        if (choice !== null && choice !== 'end' && (!Number.isInteger(choice) || !g.tiles[choice] || g.tiles[choice].revealed)) fail('请选择尚未翻开的牌。');
        if (choice === null) delete r.votes[p.id]; else r.votes[p.id] = choice;
        const n = r.players.filter(q => q.team === g.turn && q.role === 'guesser').length;
        const needed = required(r.settings.voting, n);
        if (choice !== null && Object.values(r.votes).filter(v => v === choice).length >= needed) {
          if (choice === 'end') G.stop(g); else G.guess(g,choice);
          r.votes = {}; r.epoch++;
        }
        break;
      }
      default: fail('未知操作。');
    }
    // Only successful actions reach this point, so every member is told once,
    // including the actor — their own snapshot comes back with this response.
    this.changed(r);
    return this.snapshot(r,p);
  }
}

function createServer(options = {}) {
  // Protocol ping/pong is handled by the browser networking layer, even when
  // background page timers and CSS animations are throttled. The same socket
  // carries change nudges, so it is created before the room store can use it.
  const sockets = new WebSocketServer({noServer:true,maxPayload:2048});
  // A room mutation pushes a bare "state changed" nudge to its members; the
  // client fetches the new snapshot at once instead of waiting for its timer.
  const nudge = room => {
    for (const ws of sockets.clients)
      if (ws.identity?.r === room && ws.readyState === WebSocket.OPEN) ws.send('{"changed":1}');
  };
  const rooms = new Rooms(options.data || JSON.parse(fs.readFileSync(path.join(__dirname,'anime_list.json'),'utf8')),{...options,changed:nudge});
  const files = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/multiplayer.js':'multiplayer.js','/demo.js':'demo.js','/entry.js':'entry.js','/game.js':'game.js','/styles.css':'styles.css','/fallback-data.js':'fallback-data.js','/anime_list.json':'anime_list.json'};
  const server = http.createServer(async (req,res) => {
    const json = (code,value) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const url = new URL(req.url,'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return json(403,{error:'不允许跨站请求。'});
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const {r,p} = rooms.auth(url.searchParams.get('code'),req.headers.authorization?.replace(/^Bearer /,'')); return json(200,rooms.snapshot(r,p));
        }
        if (req.method !== 'POST') return json(405,{error:'请求方法无效。'});
        let body = ''; for await (const chunk of req) {body += chunk; if (body.length>16384) return json(413,{error:'请求过大。'});}
        const a = JSON.parse(body); if (!a || typeof a !== 'object') fail('请求无效。');
        if (url.pathname === '/api/enter' && ['create','join'].includes(a.action)) return json(200,rooms.enter(a));
        if (url.pathname === '/api/action') return json(200,rooms.action(a.code,req.headers.authorization?.replace(/^Bearer /,''),a));
        return json(404,{error:'接口不存在。'});
      }
      const file = /^\/\d{6}$/.test(url.pathname) ? 'index.html' : files[url.pathname]; if (!file) {res.writeHead(404);return res.end('Not found');}
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);return res.end();}
      res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'})[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      if (req.method === 'HEAD') return res.end(); fs.createReadStream(path.join(__dirname,file)).pipe(res);
    } catch (error) {json(400,{error:error.message});}
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/api/presence'||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)){socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
  });
  sockets.on('connection',ws=>{
    ws.lastPong=Date.now();
    const touch=()=>{
      if(!ws.identity)return;
      const {r,p}=ws.identity;
      if(rooms.rooms.get(r.code)!==r||!r.players.includes(p)){ws.close(1008);return;}
      p.online=true;p.seen=r.touched=rooms.now();
    };
    ws.on('error',()=>{});
    ws.on('pong',()=>{ws.lastPong=Date.now();touch();});
    ws.on('message',raw=>{
      if(ws.identity)return;
      try{const {code,token}=JSON.parse(raw);ws.identity=rooms.auth(code,token);touch();ws.send(JSON.stringify({ready:true}));}
      catch{ws.close(1008,'Invalid session');}
    });
    ws.on('close',()=>{
      // Allow refresh/reconnect to reuse the seat without a transient pause.
      if(ws.identity){const {r,p}=ws.identity;p.seen=rooms.now();r.touched=rooms.now();}
    });
  });
  const timer = setInterval(() => {
    for(const ws of sockets.clients){
      if(Date.now()-ws.lastPong>9000||!ws.identity){ws.terminate();continue;}
      ws.ping();
    }
    rooms.sweep();
  },3000);
  timer.unref();
  server.on('close',()=>{clearInterval(timer);for(const ws of sockets.clients)ws.terminate();sockets.close();});
  return {server,rooms};
}
if (require.main === module) {
  const {server} = createServer(); const port = Number(process.env.PORT || 8765);
  server.on('error',error=>{console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请停止旧服务或设置 PORT。` : error);process.exitCode=1;});
  server.listen(port,'0.0.0.0',()=>console.log(`AniCode 联机服务：http://localhost:${port}（局域网可使用本机 IP）`));
}
module.exports = {Rooms,createServer};
