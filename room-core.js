'use strict';
/* Pure single-room rules, shared by the Durable Object and the Node tests.
   Nothing here does I/O: time and randomness are passed in, ids come from Web Crypto. */
const G = require('./game.js');

const fail = message => { throw new Error(message); };
const votingRules = ['majority','unanimous','any'];
// A drop shorter than the grace period never shows. Past it, a seated player of a
// live match is "away" and keeps their seat; anyone else has left the room.
// A room nobody is connected to for `abandonMs` is dissolved, match or not.
const options = {graceMs:60000, abandonMs:10*60*1000, idleMs:2*60*60*1000, turnSeconds:[null,60,90,120,180]};
// The Worker may shorten the grace period and add a short turn limit for browser tests.
function configure({graceMs, turnSeconds} = {}) {
  if (Number.isInteger(graceMs) && graceMs > 0) options.graceMs = graceMs;
  if (Number.isInteger(turnSeconds) && turnSeconds > 0 && !options.turnSeconds.includes(turnSeconds)) options.turnSeconds.push(turnSeconds);
}
// Only seat holders count toward the cap; anyone else in the room watches, without a limit.
const MAX_PLAYERS = 16;
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
// Votes needed to execute a guess, shared by the snapshot threshold and the vote path.
// Nobody eligible still means one vote, so an empty team never executes anything.
const required = (voting, guessers) => Math.max(1, voting === 'any' ? 1 : voting === 'unanimous' ? guessers : Math.floor(guessers/2)+1);

function validName(input) {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name || name.length > 20) fail('昵称需要 1–20 个字符。');
  return name;
}
// The browser's own id. It is as private as the token, so no snapshot carries it.
const validClient = c => typeof c === 'string' && /^[\w-]{16,64}$/.test(c) ? c : null;
function newPlayer(name, returned, now, client) {
  // A player exists before their socket does, so they start inside the grace period.
  return {id:crypto.randomUUID(), token:token(), client:validClient(client), name, codeHidden:null, team:null, role:'guesser', ready:false, returned, disconnectedAt:now, away:false};
}
function createRoom({code, id, name, dataDate, now, client}) {
  name = validName(name);
  const room = {id, code, codeHidden:false, public:false, host:null, players:[], settings:{filters:{...G.defaults, excluded:[...G.defaults.excluded], included:[]}, voting:'unanimous', rules:{...G.ruleDefaults, turnSeconds:null}}, game:null, votes:{}, epoch:0, version:0, dataDate:typeof dataDate === 'string' && dataDate.length <= 20 ? dataDate : null, touched:now};
  const player = newPlayer(name, false, now, client);
  room.players.push(player); room.host = player.id;
  return {room, player};
}
function join(room, name, now, client) {
  name = validName(name); client = validClient(client);
  // On a slow network the answer to a join can be lost after the room took it in.
  // The retry comes from the same browser, so it gets that player back, seat and
  // all, instead of a second row with the same name.
  const known = client && room.players.find(p => p.client === client);
  if (known) {known.name = name; room.touched = now; return known;}
  // A finished match is only a review screen, so a newcomer can take a lobby
  // seat straight away; a live match takes them in as a spectator, with no
  // seat, until it ends and they come back to the lobby like everyone else.
  const player = newPlayer(name, !!room.game && !live(room), now, client);
  room.players.push(player); room.touched = now;
  return player;
}

const live = r => !!r.game && r.game.phase !== 'over';
// Readiness is the player's own statement, so joins, seat moves, pool or rule
// edits and dropped connections leave it alone. It only clears when the seat is
// empty or the room comes back to the lobby for a fresh round.
function reset(r) { r.game = null; r.votes = {}; r.epoch++; for (const p of r.players) {p.ready = false; p.returned = false;} }
// A finished match is a review screen, not a lock on the room: each player
// leaves it on their own. Until they do, they hold no lobby seat, so the ones
// who already came back can re-seat and get ready without waiting.
const inLobby = (r, p) => !r.game || p.returned;
// Nobody plays a match without a seat, so a seatless player in it is watching.
const watching = (r, p) => !inLobby(r, p) && !p.team;
// The players of the next round: lobby members holding a team seat.
const playing = r => r.players.filter(p => inLobby(r, p) && p.team);
// An away player is not reading the map, so they never stall the others' way
// back to the lobby; the reset clears their flag for when they reconnect.
const reviewing = r => !!r.game && r.players.some(p => !p.returned && !p.away);
function settle(r) { if (r.game && r.game.phase === 'over' && !reviewing(r)) {reset(r); return true;} return false; }
// Only guessers who are still around decide, so an away teammate cannot stall a vote.
const eligible = r => r.players.filter(p => p.team === r.game?.turn && p.role === 'guesser' && !p.away);
// Each phase gets its own clock: a new deadline whenever the round or phase moves.
function arm(r, before, now) {
  const g = r.game;
  if (!g || g.phase === 'over' || !r.settings.rules.turnSeconds) {if (g) g.deadline = null; return;}
  if (before !== `${g.round}:${g.phase}` || g.deadline == null) g.deadline = now + r.settings.rules.turnSeconds*1000;
}
const phaseKey = r => r.game ? `${r.game.round}:${r.game.phase}` : '';
// Executes the choice that meets the threshold, if one does. Called after a vote
// and whenever the set of eligible guessers may have shrunk.
function settleVotes(r, now) {
  const g = r.game; if (!g || g.phase !== 'guess') return false;
  const voters = eligible(r), needed = required(r.settings.voting, voters.length);
  const tally = new Map();
  for (const p of voters) if (Object.hasOwn(r.votes, p.id)) tally.set(r.votes[p.id], (tally.get(r.votes[p.id]) || 0) + 1);
  for (const [choice, count] of tally) if (count >= needed) {
    const before = phaseKey(r);
    if (choice === 'end') G.stop(g); else G.guess(g, choice);
    r.votes = {}; r.epoch++; arm(r, before, now);
    return true;
  }
  return false;
}
// If the host is away, the first player still connected takes over for good.
function transferHost(r) {
  const host = r.players.find(p => p.id === r.host);
  if (host && !host.away) return false;
  const next = r.players.find(p => p.disconnectedAt === null) || (!host && (r.players.find(p => !p.away) || r.players[0]));
  if (!next || next.id === r.host) return false;
  r.host = next.id; return true;
}
// Only a seated player of a live match is held through a long drop, so the match
// can wait for them. Everyone else past the grace period has left the room.
const held = (r, p) => live(r) && !p.returned && !!p.team;
const lapsed = (r, p, now) => p.disconnectedAt !== null && now >= p.disconnectedAt + options.graceMs && !held(r, p);
// The effects of the roster changing: who lapsed, host, votes and the review
// screen. Each can set off another (a vote ends the match, which lets go of the
// away players it held), so they run until nothing moves.
function effects(r, now) {
  let changed = false;
  for (let moved = true; moved;) {
    const p = r.players.find(q => lapsed(r, q, now));
    if (p) drop(r, p, now, 'timeout');
    moved = !!p | transferHost(r) | settleVotes(r, now) | settle(r);
    if (moved) changed = true;
  }
  return changed;
}
// A player leaving mid-match only ends it when their team can no longer play.
function critical(r, p) {
  if (!live(r) || !p.team) return false;
  return p.role === 'captain' || !r.players.some(q => q !== p && q.team === p.team && q.role === 'guesser');
}
// Takes a member out, without the follow-up effects. A member who lapsed or was
// removed by the host is remembered by token for a while, so their browser can be
// told why when it comes back: a lapse offers to join again, a removal does not.
function drop(r, p, now, reason = null) {
  const ends = critical(r, p);
  r.players = r.players.filter(q => q !== p); delete r.votes[p.id];
  if (reason) {
    r.departed ??= {};
    for (const [token, d] of Object.entries(r.departed)) if (now - d.at >= options.idleMs) delete r.departed[token];
    r.departed[p.token] = {reason, at:now};
  }
  if (ends) reset(r);
}
function remove(r, p, now, reason) { drop(r, p, now, reason); effects(r, now); }
// Why a token no longer belongs to the room: 'timeout', 'kicked' or null if unknown.
const departure = (r, token) => (typeof token === 'string' && r.departed && Object.hasOwn(r.departed, token) && r.departed[token].reason) || null;

function presence(room, connectedIds, now, since = {}) {
  let changed = false;
  for (const p of room.players) {
    if (connectedIds.has(p.id)) {
      if (p.disconnectedAt !== null) {p.disconnectedAt = null; changed = true;}
    } else if (p.disconnectedAt === null) {p.disconnectedAt = Math.min(now, since[p.id] ?? now); changed = true;}
    const away = p.disconnectedAt !== null && now >= p.disconnectedAt + options.graceMs;
    if (p.away !== away) {p.away = away; changed = true;}
  }
  if (effects(room, now)) changed = true;
  return changed;
}
function due(room, now) {
  const g = room.game;
  if (!g || g.phase === 'over' || g.deadline == null || now < g.deadline) return false;
  const before = phaseKey(room);
  G.timeout(g); room.votes = {}; room.epoch++; arm(room, before, now);
  return true;
}
function nextWake(room) {
  const times = [room.touched + options.idleMs];
  if (live(room) && room.game.deadline != null) times.push(room.game.deadline);
  // A held player needs a wake to show as away; anyone else to leave, even one
  // already away whose match has just ended.
  for (const p of room.players) if (p.disconnectedAt !== null && !(p.away && held(room, p))) times.push(p.disconnectedAt + options.graceMs);
  const abandoned = abandonedAt(room);
  if (abandoned !== null) times.push(abandoned);
  return Math.min(...times);
}
// When a room nobody is connected to gets dissolved: `abandonMs` after the last one dropped.
const abandonedAt = room => room.players.length && room.players.every(p => p.disconnectedAt !== null) ? Math.max(...room.players.map(p => p.disconnectedAt)) + options.abandonMs : null;
const expired = (room, now) => !room.players.length || now - room.touched >= options.idleMs || now >= (abandonedAt(room) ?? Infinity);

function blockers(r) {
  const issues = [];
  // A player still on the review screen holds no lobby seat yet, so their old
  // match team must not satisfy a seat requirement for the next round.
  const seated = r.players.filter(p => inLobby(r, p));
  if (reviewing(r)) issues.push('等待其他玩家返回大厅');
  for (const team of ['red','blue']) {
    if (!seated.some(p => p.team === team && p.role === 'captain')) issues.push(`${G.label(team)}缺少队长`);
    if (!seated.some(p => p.team === team && p.role === 'guesser')) issues.push(`${G.label(team)}至少需要一名猜词人`);
  }
  // A lobby member without a seat sits in the spectator stands: they watch the
  // next round instead of holding it up, so only the seated players count.
  // Even a short drop blocks the start: the board should not deal to an empty chair.
  // An unseated lobby member holds no chair, so their drop does not count.
  if (r.players.some(p => p.disconnectedAt !== null && !(inLobby(r, p) && !p.team))) issues.push('等待离线玩家重连，或由房主移除');
  if (seated.some(p => p.team && !p.ready)) issues.push('等待全员准备');
  return issues;
}
function snapshot(r, p, now) {
  let game = null;
  // Returning to the lobby ends this player's review even while others read on.
  if (r.game && !p.returned) {
    // A spectator plays for neither team, so they may switch to the full map.
    const g = r.game, canSee = p.role === 'captain' || g.phase === 'over' || watching(r, p);
    // The ban is a captains-only signal: the guessers still have to read the
    // clue, not a warning label on the board. Once the card is turned over the
    // ban is no secret any more: the tile keeps it, and everyone sees its mark.
    // Whether a one-ban captain has spent theirs would tell guessers a ban is live.
    game = {...g, deadline:g.deadline ?? null, banUsed:Object.fromEntries(['red','blue'].map(team => [team, canSee && !!g.banUsed?.[team]])), banned:Object.fromEntries(['red','blue'].map(team => {const i = g.banned?.[team] ?? null; return [team, canSee || g.tiles[i]?.revealed ? i : null];})), remaining:{red:G.remaining(g,'red'), blue:G.remaining(g,'blue')}, tiles:g.tiles.map(t => ({anime:{id:t.anime.id,name_cn:G.name(t.anime),image_url:t.anime.image_url,air_date:t.anime.air_date,score:t.anime.score,vote_count:t.anime.vote_count}, revealed:t.revealed, ...(canSee || t.revealed ? {type:t.type} : {}), ...(t.bannedBy ? {bannedBy:t.bannedBy} : {})}))};
  }
  return {code:r.code, codeHidden:p.id===r.host?r.codeHidden:(p.codeHidden??r.codeHidden), public:r.public===true, host:r.host, me:p.id, dataDate:r.dataDate, players:r.players.map(({token,client,codeHidden,returned,disconnectedAt,...rest}) => ({...rest, inMatch:!!r.game && !returned})), settings:r.settings, epoch:r.epoch, game, votes:r.votes, threshold:required(r.settings.voting, eligible(r).length), blockers:blockers(r), chat:chatChannels(r, p)};
}
// What the public room list shows of a room, or null while it is private.
function listing(r) {
  if (r.public !== true) return null;
  const host = r.players.find(p => p.id === r.host);
  return {code:r.code, host:host?.name ?? '', players:r.players.length, seated:r.players.filter(p => p.team).length, max:MAX_PLAYERS, playing:live(r)};
}
// Chat is relayed, never stored: the room only decides who may speak where and
// who hears it, from the seats at the moment of sending. The lobby has one
// public channel; a match adds the captains' channel and one per team for its
// guessers. A spectator only has the public channel.
const CHAT_MAX = 100;
function chatChannels(r, p) {
  if (inLobby(r, p) || !p.team) return {hear:['public'], speak:['public']};
  const own = p.role === 'captain' ? 'captain' : p.team;
  return {hear:['public', own], speak:['public', own]};
}
function chat(r, p, a, now) {
  const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) fail('消息不能为空。');
  if (Array.from(text).length > CHAT_MAX) fail(`消息最多 ${CHAT_MAX} 个字。`);
  if (!chatChannels(r, p).speak.includes(a.channel)) fail('你现在不能在这个频道发言。');
  r.touched = now;
  const message = {id:crypto.randomUUID(), channel:a.channel, from:p.id, name:p.name, team:p.team, role:p.role, text, at:now};
  return {message, to:r.players.filter(q => chatChannels(r, q).hear.includes(a.channel)).map(q => q.id)};
}
// The host's browser deals the board; only display fields are accepted.
function validCards(cards) {
  if (!Array.isArray(cards) || cards.length !== 25) fail('牌组需要正好 25 部动画。');
  const ids = new Set();
  return cards.map(c => {
    if (!c || typeof c !== 'object') fail('牌组数据无效。');
    const {id, name_cn, image_url, air_date, score, vote_count} = c;
    if (!Number.isInteger(id) || id < 0 || ids.has(id)) fail('牌组数据无效。');
    ids.add(id);
    if (typeof name_cn !== 'string' || !name_cn.trim() || name_cn.length > 100) fail('牌组数据无效。');
    if (image_url !== null && (typeof image_url !== 'string' || image_url.length > 500 || !/^https?:\/\/[^\s]+$/.test(image_url))) fail('牌组数据无效。');
    if (air_date !== null && (typeof air_date !== 'string' || air_date.length > 20)) fail('牌组数据无效。');
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) fail('牌组数据无效。');
    if (!Number.isInteger(vote_count) || vote_count < 0) fail('牌组数据无效。');
    return {id, name_cn:name_cn.trim(), image_url, air_date, score, vote_count};
  });
}
function action(r, p, a, now, random = Math.random) {
  const host = () => { if (p.id !== r.host) fail('只有房主可以进行此操作。'); };
  const lobby = () => { if (!inLobby(r, p)) fail('请先返回大厅再调整。'); };
  r.touched = now;
  switch (a.action) {
    case 'codeVisibility':
      if (typeof a.hidden !== 'boolean') fail('房间号显示设置无效。');
      // Members follow the room default until they choose their own visibility.
      // Keep that default on host transfer so a hidden code stays hidden.
      if (p.id === r.host) {r.codeHidden = a.hidden; p.codeHidden = null;}
      else p.codeHidden = a.hidden;
      break;
    // A public room is listed for anyone to join; only the host opens or closes it.
    case 'publicRoom':
      host(); if (typeof a.public !== 'boolean') fail('公开设置无效。');
      r.public = a.public; break;
    case 'seat': {
      lobby(); if (![null,'red','blue'].includes(a.team) || !['captain','guesser'].includes(a.role)) fail('位置无效。');
      // Only players who are actually in the lobby hold a seat, so a captain
      // still reading the finished map does not block the chair.
      if (a.team && !p.team && playing(r).length >= MAX_PLAYERS) fail(`玩家已满（最多 ${MAX_PLAYERS} 人），可以留下观战。`);
      if (a.team && a.role === 'captain' && r.players.some(q => q.id !== p.id && inLobby(r,q) && q.team === a.team && q.role === 'captain')) fail('该队已经有队长，请先让出位置。');
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
      // Rooms saved before a rule existed pick up its default here.
      const rules = {...G.ruleDefaults,...r.settings.rules,...(a.rules || {})};
      if (!G.flipModes.includes(rules.maxFlips)) fail('翻牌上限设置无效。');
      if (!G.banModes.includes(rules.banMode)) fail('禁牌次数设置无效。');
      for (const key of ['freeCount','ban']) if (typeof rules[key] !== 'boolean') fail('规则设置无效。');
      if (!options.turnSeconds.includes(rules.turnSeconds)) fail('回合限时设置无效。');
      // The pool size is the host client's check: the server never sees the dataset.
      r.settings = {filters:{...f,excluded:[...f.excluded],included:[...f.included],excludeOptions:[...(f.excludeOptions||G.excludedTags)],includeOptions:[...(f.includeOptions||[])]},voting,rules:{maxFlips:rules.maxFlips,freeCount:rules.freeCount,ban:rules.ban,banMode:rules.banMode,turnSeconds:rules.turnSeconds}};
      break;
    }
    case 'start': {
      host(); lobby(); if (blockers(r).length) fail(blockers(r).join('；'));
      const cards = validCards(a.cards), {maxFlips, freeCount, ban, banMode = G.ruleDefaults.banMode} = r.settings.rules;
      r.game = G.create(cards,random,random()<0.5?'red':'blue',{maxFlips,freeCount,ban,banMode}); r.votes = {}; r.epoch++;
      arm(r, '', now);
      for (const q of r.players) q.returned = false;
      break;
    }
    // Reviewing the finished map is each player's own business: they leave it
    // one by one and the room only resets once the last one is out. An
    // unfinished match is still shared, so the host ends it for everyone.
    case 'lobby':
      if (!r.game) break;
      if (r.game.phase !== 'over') { host(); reset(r); break; }
      p.returned = true; p.ready = false; r.epoch++;
      settle(r);
      break;
    // The host may remove any other member, online or not. Like a leave, it only
    // ends the match when the member's team can no longer play.
    case 'kick': {
      host(); const target = r.players.find(q => q.id === a.player);
      if (!target) fail('这名成员已不在房间里。');
      if (target === p) fail('不能移除自己，请使用离开房间。');
      remove(r, target, now, 'kicked'); break;
    }
    case 'leave':
      remove(r, p, now);
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
        const before = phaseKey(r);
        if (!G.giveClue(g,word,blank ? null : a.count)) fail('提示无效，请检查提示词和张数。');
        r.epoch++; r.votes = {}; arm(r, before, now); break;
      }
      if (p.role !== 'guesser' || g.phase !== 'guess') fail('仅当轮猜词人可以投票。');
      const choice = a.choice;
      if (choice !== null && choice !== 'end' && (!Number.isInteger(choice) || !g.tiles[choice] || g.tiles[choice].revealed)) fail('请选择尚未翻开的牌。');
      if (choice === null) delete r.votes[p.id]; else r.votes[p.id] = choice;
      settleVotes(r, now);
      break;
    }
    default: fail('未知操作。');
  }
  // An action can end the match, which lets go of the away players it held.
  effects(r, now);
  return {ok:true};
}

module.exports = {MAX_PLAYERS, CHAT_MAX, options, configure, required, createRoom, join, action, snapshot, presence, due, nextWake, expired, departure, live, blockers, validCards, chat, listing};
