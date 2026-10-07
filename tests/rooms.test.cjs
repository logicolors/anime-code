const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../game.js');
const {Rooms,createServer}=require('../server.cjs');
const {WebSocket}=require('ws');
const {once}=require('node:events');
const data=Array.from({length:40},(_,id)=>({id,name_cn:'动画'+id,vote_count:3000,air_date:'2020-01-01',score:id<30?8:7,tags:[]}));
function fixture(n=4,random=()=>0.8){
 let now=1000;const rooms=new Rooms(data,{now:()=>now,random});
 const players=[rooms.enter({action:'create',name:'玩家0'})],code=players[0].state.code;
 for(let i=1;i<n;i++)players.push(rooms.enter({action:'join',name:'玩家'+i,code}));
 const state=i=>{const {r,p}=rooms.auth(code,players[i].token);return rooms.snapshot(r,p);};
 const act=(i,action,extra={})=>rooms.action(code,players[i].token,{action,epoch:state(i).epoch,...extra});
 const seat=(i,team,role)=>act(i,'seat',{team,role});
 seat(0,'red','captain');seat(1,'red','guesser');seat(2,'blue','captain');seat(3,'blue','guesser');
 for(let i=4;i<n;i++)seat(i,'blue','guesser');
 const ready=()=>players.forEach((_,i)=>act(i,'ready',{ready:true}));
 const start=()=>{ready();act(0,'start');};
 return {rooms,players,code,state,act,seat,ready,start,tick:n=>now+=n};
}
test('room lookup, capacity and authorization',()=>{
 const f=fixture();assert.match(f.code,/^\d{6}$/);
 assert.throws(()=>f.rooms.enter({action:'join',name:'x',code:'000000'}),/找不到/);
 assert.throws(()=>f.rooms.auth(f.code,'wrong'),/身份/);
 assert.throws(()=>f.act(1,'settings',{voting:'unanimous'}),/房主/);
 assert.throws(()=>f.act(1,'start'),/房主/);
 assert.throws(()=>f.seat(1,'red','captain'),/已有|已经/);
});
test('room code visibility follows the host unless a member overrides it, without resetting readiness',()=>{
 const f=fixture();f.ready();const before=f.state(0);
 assert.equal(before.codeHidden,false);
 assert.throws(()=>f.act(1,'codeVisibility',{hidden:'true'}),/无效/);
 f.act(0,'codeVisibility',{hidden:true});
 for(let i=0;i<4;i++)assert.equal(f.state(i).codeHidden,true);
 assert.deepEqual(f.state(0).players,before.players);
 f.act(1,'codeVisibility',{hidden:false});
 assert.equal(f.state(1).codeHidden,false);assert.equal(f.state(0).codeHidden,true);assert.equal(f.state(2).codeHidden,true);
 f.act(0,'codeVisibility',{hidden:false});f.act(0,'codeVisibility',{hidden:true});
 assert.equal(f.state(1).codeHidden,false);assert.equal(f.state(2).codeHidden,true);
 f.act(0,'start');f.act(0,'codeVisibility',{hidden:false});
 assert.equal(f.state(2).codeHidden,false);assert.equal(f.state(0).game.phase,'clue');
 f.act(0,'lobby');f.act(0,'codeVisibility',{hidden:true});
 const newcomer=f.rooms.enter({action:'join',name:'新成员',code:f.code});
 assert.equal(newcomer.state.codeHidden,true);
 f.act(0,'leave');
 assert.equal(f.state(1).host,f.state(1).me);assert.equal(f.state(1).codeHidden,true);
 f.act(1,'codeVisibility',{hidden:false});assert.equal(f.state(2).codeHidden,false);
});
test('leaving a captain or guesser seat keeps the player in the room and clears only their own readiness',()=>{
 for(const i of [0,1]){
  const f=fixture();f.ready();const before=f.state(i);
  const after=f.seat(i,null,'guesser'),me=after.players.find(p=>p.id===after.me);
  assert.equal(me.team,null);assert.equal(me.role,'guesser');assert.equal(after.players.length,4);
  assert.equal(me.ready,false);assert.ok(after.players.filter(p=>p.id!==after.me).every(p=>p.ready));
  assert.equal(after.host,before.host);assert.ok(after.blockers.includes('还有玩家未选位置'));
 }
});
test('joining, moving seats and editing settings leave readiness untouched',()=>{
 const f=fixture(5);f.ready();
 assert.ok(f.seat(4,'red','guesser').players.every(p=>p.ready));
 f.act(0,'settings',{voting:'unanimous'});assert.ok(f.state(0).players.every(p=>p.ready));
 f.act(0,'settings',{filters:{...f.state(0).settings.filters,minScore:8}});
 assert.ok(f.state(0).players.every(p=>p.ready));assert.deepEqual(f.state(0).blockers,[]);
 const newcomer=f.rooms.enter({action:'join',name:'新成员',code:f.code});
 const others=newcomer.state.players.filter(p=>p.id!==newcomer.state.me);
 assert.equal(others.length,5);assert.ok(others.every(p=>p.ready));
 assert.deepEqual(f.state(0).blockers,['还有玩家未选位置','等待全员准备']);
});
test('start requires full readiness and rejects an unusable pool',()=>{
 const f=fixture();assert.throws(()=>f.act(0,'start'),/准备/);f.ready();
 f.act(0,'settings',{voting:'unanimous'});
 assert.throws(()=>f.act(0,'settings',{filters:{...f.state(0).settings.filters,minVotes:999999}}),/25/);
 f.start();assert.throws(()=>f.seat(1,'blue','guesser'),/大厅/);
 assert.throws(()=>f.rooms.enter({action:'join',name:'late',code:f.code}),/对局/);
});
test('pool changes preserve readiness and start with the new pool',()=>{
 const f=fixture();f.ready();f.act(1,'ready',{ready:false});
 const before=f.state(0);
 const filters={...before.settings.filters,minScore:8};
 const updated=f.act(0,'settings',{filters});
 assert.deepEqual(updated.players.map(p=>p.ready),before.players.map(p=>p.ready));
 assert.equal(updated.poolCount,30);
 f.act(1,'ready',{ready:true});
 assert.deepEqual(f.state(0).blockers,[]);
 const pool=new Set(G.filter(data,filters).map(a=>a.id));
 f.act(0,'start');assert.ok(f.state(0).game.tiles.every(t=>pool.has(t.anime.id)));
});
test('both first teams receive nine cards; hidden map is omitted from guesser payload',()=>{
 for(const random of [()=>0.2,()=>0.8]){
  const f=fixture(4,random);f.start();const c=f.state(0),g=f.state(1);
  assert.equal(c.game.turn,random()<0.5?'red':'blue');
  assert.equal(c.game.remaining[c.game.turn],9);assert.equal(c.game.tiles.filter(t=>t.type===c.game.turn).length,9);
  assert.equal(c.game.tiles.filter(t=>t.type).length,25);assert.ok(g.game.tiles.every(t=>!Object.hasOwn(t,'type')));
  assert.ok(g.players.every(p=>!p.token&&!p.seen));
 }
});
test('role checks, strict majority, changing votes and stale requests',()=>{
 const f=fixture(6);f.act(0,'settings',{voting:'majority'});f.start();assert.throws(()=>f.act(0,'clue',{word:'时间',count:2}),/回合/);
 assert.throws(()=>f.act(3,'clue',{word:'时间',count:2}),/队长/);
 f.act(2,'clue',{word:'时间',count:2});assert.throws(()=>f.act(2,'vote',{choice:0}),/猜词人/);
 const index=f.state(2).game.tiles.findIndex(t=>t.type==='blue'),other=f.state(2).game.tiles.findIndex(t=>t.type==='neutral');
 f.act(3,'vote',{choice:index});assert.equal(f.state(3).game.tiles[index].revealed,false);
 f.act(3,'vote',{choice:other});assert.equal(Object.keys(f.state(3).votes).length,1);
 f.act(3,'vote',{choice:null});assert.equal(Object.keys(f.state(3).votes).length,0);
 f.act(3,'vote',{choice:index});const epoch=f.state(3).epoch;f.act(4,'vote',{choice:index});
 assert.equal(f.state(3).game.tiles[index].revealed,true);assert.equal(f.state(3).game.tiles[index].type,'blue');
 assert.deepEqual(f.state(3).votes,{});assert.throws(()=>f.act(5,'vote',{choice:other,epoch}),/已更新/);
 assert.equal(f.state(3).game.tiles[other].revealed,false);
});
test('operation validation explains the local failure and preserves the current turn',()=>{
 const f=fixture();f.start();
 assert.throws(()=>f.act(2,'clue',{word:'',count:2}),/提示词不能为空/);
 assert.throws(()=>f.act(2,'clue',{word:'two words',count:2}),/不能包含空格/);
 assert.throws(()=>f.act(2,'clue',{word:'时间',count:-1}),/不能为负数/);
 assert.equal(f.state(2).game.phase,'clue');
 f.act(2,'clue',{word:'时间',count:1});
 assert.throws(()=>f.act(3,'vote',{choice:0,epoch:f.state(3).epoch-1}),/已更新/);
});
test('ties wait, unanimous requires all, stop is a vote and clears old votes',()=>{
 const f=fixture(5);f.act(0,'settings',{voting:'unanimous'});f.start();f.act(2,'clue',{word:'时间',count:1});
 f.act(3,'vote',{choice:0});f.act(4,'vote',{choice:'end'});assert.equal(f.state(3).game.phase,'guess');
 f.act(3,'vote',{choice:'end'});assert.equal(f.state(3).game.turn,'red');assert.deepEqual(f.state(3).votes,{});
 assert.equal(f.state(3).game.clue,null);
});
test('any voting needs a single vote even with several guessers, and unknown rules are rejected',()=>{
 const f=fixture(6);assert.throws(()=>f.act(0,'settings',{voting:'always'}),/投票规则无效/);
 assert.equal(f.state(0).settings.voting,'unanimous');
 f.act(0,'settings',{voting:'any'});f.start();f.act(2,'clue',{word:'时间',count:2});
 assert.equal(f.state(3).threshold,1);
 const index=f.state(2).game.tiles.findIndex(t=>t.type==='blue'),epoch=f.state(3).epoch;
 f.act(3,'vote',{choice:null});
 assert.equal(f.state(3).epoch,epoch);assert.deepEqual(f.state(3).votes,{});
 f.act(3,'vote',{choice:index});
 assert.equal(f.state(3).game.tiles[index].revealed,true);assert.equal(f.state(2).game.tiles[index].type,'blue');
 assert.deepEqual(f.state(3).votes,{});assert.equal(f.state(3).epoch,epoch+1);
 assert.equal(f.state(3).game.turn,'blue');assert.equal(f.state(3).game.phase,'guess');
});
test('advanced rules are host-only, patched field by field, and travel with the board',()=>{
 const f=fixture();
 assert.deepEqual(f.state(0).settings.rules,{maxFlips:'clue',freeCount:true,ban:false,banMode:'game'});
 assert.throws(()=>f.act(1,'settings',{rules:{ban:true}}),/房主/);
 assert.throws(()=>f.act(0,'settings',{rules:{maxFlips:'两张'}}),/翻牌上限/);
 assert.throws(()=>f.act(0,'settings',{rules:{freeCount:'yes'}}),/规则设置/);
 assert.deepEqual(f.state(0).settings.rules,{maxFlips:'clue',freeCount:true,ban:false,banMode:'game'});
 // A patch leaves the rules it does not mention alone, so an older client that
 // only sends the voting rule cannot silently reset the rest.
 f.act(0,'settings',{rules:{ban:true}});
 f.act(0,'settings',{voting:'any'});
 assert.deepEqual(f.state(0).settings.rules,{maxFlips:'clue',freeCount:true,ban:true});
 f.start();
 assert.deepEqual(f.state(3).game.rules,{maxFlips:'clue',freeCount:true,ban:true,banMode:'game'});
});
test('the flip budget is the clue number plus one and ends the round on the bonus card',()=>{
 const f=fixture();f.start();f.act(2,'clue',{word:'时间',count:1});
 const blues=f.state(2).game.tiles.flatMap((t,i)=>t.type==='blue'?[i]:[]);
 f.act(3,'vote',{choice:blues[0]});assert.equal(f.state(3).game.phase,'guess');
 f.act(3,'vote',{choice:blues[1]});
 assert.equal(f.state(3).game.remaining.blue,7,'both cards still count');
 assert.equal(f.state(3).game.turn,'red');assert.equal(f.state(3).game.round,2);
});
test('a blank clue number follows the room rule and lifts the budget',()=>{
 const strict=fixture();strict.act(0,'settings',{rules:{freeCount:false}});strict.start();
 for(const extra of [{},{count:null}])assert.throws(()=>strict.act(2,'clue',{word:'时间',...extra}),/必须填写提示张数/);
 strict.act(2,'clue',{word:'时间',count:1});assert.equal(strict.state(2).game.clue.count,1);
 const free=fixture();free.start();
 free.act(2,'clue',{word:'时间'});
 assert.equal(free.state(3).game.clue.count,null);
 const blues=free.state(2).game.tiles.flatMap((t,i)=>t.type==='blue'?[i]:[]);
 for(const i of blues.slice(0,3))free.act(3,'vote',{choice:i});
 assert.equal(free.state(3).game.phase,'guess');assert.equal(free.state(3).game.turn,'blue');
});
test('only the acting captain bans, only before the clue, and only captains see it',()=>{
 const off=fixture();off.start();
 assert.throws(()=>off.act(2,'ban',{index:0}),/没有开启/);
 const f=fixture();f.act(0,'settings',{rules:{ban:true}});f.start();
 // The frozen server cannot pick the ban mode, so pin the per-round one it was written for.
 f.rooms.auth(f.code,f.players[0].token).r.game.rules.banMode='round';
 assert.throws(()=>f.act(3,'ban',{index:0}),/队长/);
 assert.throws(()=>f.act(0,'ban',{index:0}),/回合/);
 assert.throws(()=>f.act(2,'ban',{index:99}),/尚未翻开/);
 const of=type=>f.state(2).game.tiles.flatMap((t,i)=>t.type===type?[i]:[]);
 const blues=of('blue'),reds=of('red');
 f.act(2,'ban',{index:blues[1]});
 // Both captains read the ban off the board; the guessers only have the clue.
 assert.deepEqual(f.state(2).game.banned,{red:null,blue:blues[1]});
 assert.deepEqual(f.state(0).game.banned,{red:null,blue:blues[1]},'the opposing captain sees it too');
 assert.deepEqual(f.state(3).game.banned,{red:null,blue:null},'a guesser is not told');
 f.act(2,'ban',{index:null});assert.equal(f.state(2).game.banned.blue,null);
 f.act(2,'ban',{index:reds[1]});
 f.act(2,'clue',{word:'时间',count:3});
 assert.throws(()=>f.act(2,'ban',{index:blues[2]}),/出题阶段/);
 f.act(3,'vote',{choice:blues[0]});assert.equal(f.state(3).game.phase,'guess');
 f.act(3,'vote',{choice:'end'});
 // The blue ban outlives its own round and now stands in the way of red.
 assert.equal(f.state(1).game.turn,'red');assert.equal(f.state(0).game.banned.blue,reds[1]);
 assert.throws(()=>f.act(0,'ban',{index:reds[1]}),/对方禁用/);
 f.act(0,'clue',{word:'机器人',count:3});
 f.act(1,'vote',{choice:reds[1]});
 assert.equal(f.state(1).game.remaining.red,7,'the banned card is still credited');
 assert.equal(f.state(1).game.turn,'blue','the opposing ban ends the round');
 assert.deepEqual(f.state(2).game.banned,{red:null,blue:null});
 // A ban that has been turned over is no secret: every guesser sees its mark
 // for the rest of the game, after the live ban has cleared.
 f.act(2,'ban',{index:blues[2]});
 assert.equal(f.state(1).game.banned.blue,null,'a live ban stays hidden from guessers');
 f.act(2,'clue',{word:'时间',count:3});f.act(3,'vote',{choice:blues[2]});
 assert.equal(f.state(1).game.turn,'red');
 for(const i of [0,1,2,3])assert.equal(f.state(i).game.banned.blue,blues[2]);
 f.act(0,'clue',{word:'机器人',count:1});f.act(1,'vote',{choice:'end'});
 assert.equal(f.state(3).game.turn,'blue');assert.deepEqual(f.state(3).game.banned,{red:null,blue:null});
 for(const i of [0,1,2,3]){const {tiles}=f.state(i).game;assert.equal(tiles[blues[2]].bannedBy,'blue');assert.equal(tiles[reds[1]].bannedBy,'blue');}
 assert.equal(f.state(1).game.tiles.filter(t=>t.bannedBy).length,2,'only turned-over bans are recorded on tiles');
});
test('single guesser vote resolves immediately; assassin exposes review; captain swap next game',()=>{
 const f=fixture();f.start();f.act(2,'clue',{word:'时间',count:1});
 const index=f.state(2).game.tiles.findIndex(t=>t.type==='assassin');f.act(3,'vote',{choice:index});
 assert.equal(f.state(1).game.winner,'red');assert.ok(f.state(1).game.tiles.every(t=>t.type));
 // Each player leaves the review alone; the room only resets once the last one does.
 f.act(1,'lobby');
 assert.equal(f.state(1).game,null);assert.equal(f.state(1).players.find(p=>p.id===f.state(1).me).inMatch,false);
 assert.ok(f.state(0).game,'others keep reading the map');
 assert.ok(f.state(1).blockers.includes('等待其他玩家返回大厅'));
 // The returning player keeps last round's seat and can get ready right away.
 assert.equal(f.state(1).players.find(p=>p.id===f.state(1).me).team,'red');
 f.act(1,'ready',{ready:true});
 assert.equal(f.state(1).players.find(p=>p.id===f.state(1).me).ready,true);
 // A captain still on the review screen does not hold the chair.
 f.seat(1,'blue','captain');
 assert.equal(f.state(1).players.filter(p=>p.inMatch).length,3);
 for(const i of [0,2,3])f.act(i,'lobby');
 assert.ok(f.state(1).players.every(p=>!p.ready&&!p.inMatch));assert.equal(f.state(1).game,null);
 f.seat(0,'red','guesser');f.seat(1,'red','captain');f.start();
 assert.ok(f.state(0).game.tiles.every(t=>!t.type));assert.ok(f.state(1).game.tiles.every(t=>t.type));
});
test('an unfinished match is still ended for everyone by the host alone',()=>{
 const f=fixture();f.start();
 assert.throws(()=>f.act(1,'lobby'),/房主/);
 f.act(0,'lobby');
 assert.equal(f.state(2).game,null);assert.ok(f.state(2).players.every(p=>!p.inMatch));
});
test('a newcomer can take a lobby seat while others review, but not mid-match',()=>{
 const f=fixture();f.start();
 assert.throws(()=>f.rooms.enter({action:'join',name:'新成员',code:f.code}),/对局中/);
 const index=f.state(2).game.tiles.findIndex(t=>t.type==='assassin');
 f.act(2,'clue',{word:'时间',count:1});f.act(3,'vote',{choice:index});
 const newcomer=f.rooms.enter({action:'join',name:'新成员',code:f.code});
 assert.equal(newcomer.state.game,null);
 assert.equal(newcomer.state.players.find(p=>p.id===newcomer.state.me).inMatch,false);
});
test('an offline player never stalls the others way back to the lobby',()=>{
 const f=fixture();f.start();
 const index=f.state(2).game.tiles.findIndex(t=>t.type==='assassin');
 f.act(2,'clue',{word:'时间',count:1});f.act(3,'vote',{choice:index});
 f.tick(10000);[0,1,2].forEach(f.state);f.tick(3000);f.rooms.sweep();
 for(const i of [0,1,2])f.act(i,'lobby');
 assert.equal(f.state(0).game,null,'the offline player 3 does not hold the review open');
 assert.ok(f.state(0).players.every(p=>!p.inMatch));
});
test('disconnect preserves votes and board version, transfers host and allows play to continue',()=>{
 const f=fixture(5);f.start();f.act(2,'clue',{word:'时间',count:1});f.act(3,'vote',{choice:0});
 const before=f.state(1);
 f.tick(10000);[1,2,3,4].forEach(f.state);f.tick(3000);f.rooms.sweep();
 const s=f.state(1);assert.equal(s.host,s.me);assert.deepEqual(s.votes,before.votes);assert.equal(s.epoch,before.epoch);assert.equal(s.threshold,2);
 f.act(3,'vote',{choice:'end'});f.act(4,'vote',{choice:'end'});assert.equal(f.state(1).game.turn,'red');
 f.state(0);assert.equal(f.state(1).host,s.me);assert.equal(f.state(0).game.turn,'red');
});
test('offline guesser retains their submitted vote; online captain and guessers can finish the turn',()=>{
 const f=fixture(5);f.start();f.act(2,'clue',{word:'时间',count:1});f.act(4,'vote',{choice:'end'});
 f.tick(10000);[0,1,2,3].forEach(f.state);f.tick(3000);f.rooms.sweep();
 assert.equal(f.state(3).threshold,2);assert.equal(Object.values(f.state(3).votes)[0],'end');
 f.act(3,'vote',{choice:'end'});assert.equal(f.state(1).game.turn,'red');
 f.act(0,'clue',{word:'星空',count:1});f.act(1,'vote',{choice:'end'});
 assert.equal(f.state(1).game.turn,'blue');assert.equal(f.state(1).game.round,3);
 assert.equal(f.state(4).game.round,3);
});
test('removing offline players and leaving return everyone to lobby',()=>{
 const f=fixture();f.start();f.tick(10000);[0,1,2].forEach(f.state);f.tick(3000);f.rooms.sweep();
 assert.throws(()=>f.act(0,'kick',{player:f.state(1).me}),/离线/);
 f.act(0,'kick',{player:f.players[3].state.me});assert.equal(f.state(0).game,null);assert.equal(f.state(0).players.length,3);
 f.act(0,'leave');assert.equal(f.state(1).host,f.state(1).me);
});
test('empty rooms and inactive rooms are removed',()=>{
 const rooms=new Rooms(data);const p=rooms.enter({action:'create',name:'solo'});
 rooms.action(p.state.code,p.token,{action:'leave'});assert.equal(rooms.rooms.size,0);
 const f=fixture();f.tick(7200001);f.rooms.sweep();assert.equal(f.rooms.rooms.size,0);
});
test('HTTP server rejects forged actions, cross-origin writes and private paths',async()=>{
 const {server}=createServer({data});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const enter=await fetch(base+'/api/enter',{method:'POST',body:JSON.stringify({action:'create',name:'http'})});const p=await enter.json();
  assert.equal(enter.status,200);
  const state=await fetch(base+'/api/state?code='+p.state.code,{headers:{Authorization:'Bearer '+p.token}});assert.equal(state.status,200);
  assert.equal((await fetch(base+'/server.cjs')).status,404);
  assert.equal((await fetch(base+'/api/action',{method:'POST',body:JSON.stringify({code:p.state.code,action:'start'})})).status,400);
  assert.equal((await fetch(base+'/api/enter',{method:'POST',headers:{Origin:'http://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/enter',{method:'POST',body:'null'})).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('presence socket authenticates credentials and protocol pong renews the seat without state polling',async()=>{
 let now=1000;const {server,rooms}=createServer({data,now:()=>now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address='ws://127.0.0.1:'+server.address().port+'/api/presence';
 const joined=rooms.enter({action:'create',name:'background'});
 const socket=new WebSocket(address),invalid=new WebSocket(address);
 try{
  await Promise.all([once(socket,'open'),once(invalid,'open')]);
  const ready=once(socket,'message');socket.send(JSON.stringify({code:joined.state.code,token:joined.token}));
  assert.deepEqual(JSON.parse((await ready)[0]),{ready:true});
  const denied=once(invalid,'close');invalid.send(JSON.stringify({code:joined.state.code,token:'forged'}));
  assert.equal((await denied)[0],1008);
  now+=20000;
  const r=rooms.rooms.get(joined.state.code),p=r.players[0];
  socket.pong();
  await new Promise((resolve,reject)=>{const deadline=Date.now()+1000;const check=()=>{if(p.seen===now)return resolve();if(Date.now()>deadline)return reject(new Error('Protocol pong did not renew presence'));setTimeout(check,10);};check();});
  rooms.sweep();assert.equal(p.online,true);assert.equal(r.host,p.id);
  assert.equal(rooms.snapshot(r,p).players[0].token,undefined);
 }finally{
  const closed=socket.readyState===WebSocket.CLOSED?Promise.resolve():once(socket,'close');socket.terminate();invalid.terminate();await closed;
  await new Promise(resolve=>server.close(resolve));
 }
});
test('room changes are pushed over the presence socket instead of waiting for a poll',async()=>{
 let now=1000;const {server,rooms}=createServer({data,now:()=>now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address='ws://127.0.0.1:'+server.address().port+'/api/presence';
 const host=rooms.enter({action:'create',name:'host'});
 const guest=rooms.enter({action:'join',name:'guest',code:host.state.code});
 const socket=new WebSocket(address);
 try{
  await once(socket,'open');
  const ready=once(socket,'message');socket.send(JSON.stringify({code:host.state.code,token:host.token}));
  assert.deepEqual(JSON.parse((await ready)[0]),{ready:true});
  // Another member acting is pushed to everyone, and carries no state itself.
  const seated=once(socket,'message');
  rooms.action(host.state.code,guest.token,{action:'seat',team:'red',role:'guesser'});
  assert.deepEqual(JSON.parse((await seated)[0]),{changed:1});
  // Reading state changes nothing, so an idle room stays quiet.
  const idle=Promise.race([once(socket,'message').then(()=>'pushed'),new Promise(resolve=>setTimeout(()=>resolve('quiet'),150))]);
  rooms.auth(host.state.code,host.token);
  assert.equal(await idle,'quiet');
  // Nobody requests a disconnect, which is exactly why it has to be pushed.
  const dropped=once(socket,'message');now+=20000;rooms.sweep();
  assert.deepEqual(JSON.parse((await dropped)[0]),{changed:1});
  assert.equal(rooms.rooms.get(host.state.code).players.find(p=>p.name==='guest').online,false);
 }finally{
  const closed=socket.readyState===WebSocket.CLOSED?Promise.resolve():once(socket,'close');socket.terminate();await closed;
  await new Promise(resolve=>server.close(resolve));
 }
});
test('room filters accept 0–10 scores and custom include/exclude tags',()=>{
 const source=Array.from({length:60},(_,id)=>({id,name_cn:'custom '+id,vote_count:3000,air_date:'2020-01-01',score:id<30?8:7,tags:['custom',...(id<30?['high']:['low'])]}));
 const rooms=new Rooms(source),entry=rooms.enter({action:'create',name:'host'}),code=entry.state.code;
 const initial=entry.state.settings.filters;
 const filters={...initial,minScore:8,maxScore:8,excluded:['low'],included:['custom','high'],excludeOptions:['low','disabled exclusion'],includeOptions:['custom','high','disabled inclusion']};
 const state=rooms.action(code,entry.token,{action:'settings',filters});
 assert.equal(state.poolCount,30);assert.deepEqual(state.settings.filters.included,['custom','high']);
 assert.deepEqual(state.settings.filters.excludeOptions,filters.excludeOptions);
 assert.deepEqual(state.settings.filters.includeOptions,filters.includeOptions);
 const before=JSON.stringify(state.settings);
 // Every 0.1 step on the 0–10 scale stays acceptable; only finer steps are rejected.
 assert.equal(rooms.action(code,entry.token,{action:'settings',filters:{...filters,minScore:7.9,maxScore:8.3}}).poolCount,30);
 rooms.action(code,entry.token,{action:'settings',filters});
 for(const change of [{minScore:7.05},{maxScore:11},{minScore:9,maxScore:8},{included:['']},{excluded:[42]},{included:['custom','custom']},{excludeOptions:'bad'},{includeOptions:[null]},{included:['a'.repeat(31)]},{excluded:Array.from({length:101},(_,i)=>String(i))}]){
  assert.throws(()=>rooms.action(code,entry.token,{action:'settings',filters:{...filters,...change}}));
 }
 const {r,p}=rooms.auth(code,entry.token);assert.equal(JSON.stringify(rooms.snapshot(r,p).settings),before);
});
