const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../game.js');
const core=require('../room-core.js');
const GRACE=core.options.graceMs;
const data=Array.from({length:40},(_,id)=>({id,name_cn:'动画'+id,image_url:'https://lain.bgm.tv/pic/'+id+'.jpg',vote_count:3000,air_date:'2020-01-01',score:id<30?8:7,tags:[]}));
const deal=(pool=data)=>pool.slice(0,25).map(({id,name_cn,image_url,air_date,score,vote_count})=>({id,name_cn,image_url,air_date,score,vote_count}));
function fixture(n=4,random=()=>0.8){
 let now=1000;
 const {room,player}=core.createRoom({code:'123456',id:'room-1',name:'玩家0',dataDate:G.dataDate,now});
 const players=[player];
 for(let i=1;i<n;i++)players.push(core.join(room,'玩家'+i,now));
 // Every player starts connected; tests drop them on purpose.
 const online=new Set(players.map(p=>p.id));
 const sync=()=>core.presence(room,online,now);
 sync();
 const state=i=>core.snapshot(room,players[i],now);
 const act=(i,action,extra={})=>{core.due(room,now);sync();return core.action(room,players[i],{action,epoch:room.epoch,...extra},now,random);};
 const seat=(i,team,role)=>act(i,'seat',{team,role});
 const seats=[['red','captain'],['red','guesser'],['blue','captain'],['blue','guesser']];
 for(let i=0;i<n;i++)seat(i,...(seats[i]||['blue','guesser']));
 const ready=()=>players.forEach((_,i)=>act(i,'ready',{ready:true}));
 const start=(cards=deal())=>{ready();act(0,'start',{cards});};
 const drop=i=>{online.delete(players[i].id);return sync();};
 const back=i=>{online.add(players[i].id);return sync();};
 const tick=ms=>{now+=ms;core.due(room,now);return sync();};
 return {room,players,state,act,seat,ready,start,drop,back,tick,sync,now:()=>now};
}
const tilesOf=(f,type)=>f.state(0).game.tiles.flatMap((t,i)=>t.type===type?[i]:[]);

test('permissions and seats',()=>{
 const f=fixture();
 assert.throws(()=>f.act(1,'settings',{voting:'unanimous'}),/房主/);
 assert.throws(()=>f.act(1,'start'),/房主/);
 assert.throws(()=>f.seat(1,'red','captain'),/已经有队长/);
 assert.throws(()=>f.seat(1,'green','guesser'),/位置无效/);
 assert.throws(()=>f.act(0,'dance'),/未知操作/);
});
test('names are checked and only 16 players take seats, with unlimited spectators',()=>{
 assert.throws(()=>core.createRoom({code:'1',id:'x',name:'  ',now:0}),/昵称/);
 const f=fixture(16);
 assert.throws(()=>core.join(f.room,'a'.repeat(21),f.now()),/昵称/);
 const watchers=Array.from({length:20},(_,i)=>core.join(f.room,'观众'+i,f.now()));
 assert.equal(f.room.players.length,36);
 const watcher=watchers[0],act=(p,a)=>core.action(f.room,p,{epoch:f.room.epoch,...a},f.now());
 assert.throws(()=>act(watcher,{action:'seat',team:'blue',role:'guesser'}),/玩家已满/);
 // A seated player may still move between seats while the room is full.
 f.seat(15,'red','guesser');
 // Unseated spectators no longer hold up the start.
 core.presence(f.room,new Set(f.players.map(p=>p.id)),f.now());
 f.ready();assert.deepEqual(f.state(0).blockers,[]);
 f.act(0,'start',{cards:deal()});
 const view=core.snapshot(f.room,watcher,f.now());
 assert.ok(view.game&&view.game.tiles.every(t=>t.type),'a lobby spectator watches the match');
 // A freed seat is open to a spectator again once the room is back in the lobby.
 f.act(0,'lobby');f.seat(15,null,'guesser');
 assert.equal(act(watcher,{action:'seat',team:'blue',role:'guesser'}).ok,true);
});
test('lobby members in the spectator stands never hold up the start, even with seats open',()=>{
 const f=fixture(5);f.seat(4,null,'guesser');
 const watcher=core.join(f.room,'观众',f.now());f.sync();
 for(let i=0;i<4;i++)f.act(i,'ready',{ready:true});assert.deepEqual(f.state(0).blockers,[]);
 f.act(0,'start',{cards:deal()});
 assert.equal(f.state(0).game.phase,'clue');
 for(const p of [f.players[4],watcher]){
  const view=core.snapshot(f.room,p,f.now());
  assert.ok(view.game.tiles.every(t=>t.type),'an unseated member watches the match');
  assert.deepEqual(view.chat.speak,['public']);
 }
});
test('room code visibility follows the host unless a member overrides it',()=>{
 const f=fixture();f.ready();
 f.act(0,'codeVisibility',{hidden:true});
 for(let i=0;i<4;i++)assert.equal(f.state(i).codeHidden,true);
 f.act(1,'codeVisibility',{hidden:false});
 assert.equal(f.state(1).codeHidden,false);assert.equal(f.state(2).codeHidden,true);
 assert.throws(()=>f.act(1,'codeVisibility',{hidden:'no'}),/无效/);
});
test('snapshots hide tokens, presence internals and the map from guessers',()=>{
 const f=fixture();f.start();const c=f.state(2),g=f.state(3);
 assert.ok(g.players.every(p=>!('token' in p)&&!('disconnectedAt' in p)&&p.away===false));
 assert.equal(c.game.tiles.filter(t=>t.type).length,25);assert.ok(g.game.tiles.every(t=>!('type' in t)));
 assert.equal(c.dataDate,G.dataDate);assert.ok(!('poolCount' in c));
 assert.deepEqual(Object.keys(g.game.tiles[0].anime).sort(),['air_date','id','image_url','name_cn','score','vote_count']);
 assert.equal(g.game.deadline,null);
});
test('both first teams receive nine cards dealt from the host cards',()=>{
 for(const random of [()=>0.2,()=>0.8]){
  const f=fixture(4,random);const cards=deal(data.slice(10));f.start(cards);
  const g=f.state(0).game,ids=new Set(cards.map(c=>c.id));
  assert.equal(g.turn,random()<0.5?'red':'blue');assert.equal(g.remaining[g.turn],9);
  assert.ok(g.tiles.every(t=>ids.has(t.anime.id)));
 }
});
test('start validates the dealt cards',()=>{
 const good=deal();
 const bad=[
  good.slice(0,24),[...good.slice(0,24),good[0]],
  good.map((c,i)=>i?c:{...c,id:-1}),good.map((c,i)=>i?c:{...c,id:1.5}),
  good.map((c,i)=>i?c:{...c,name_cn:''}),good.map((c,i)=>i?c:{...c,name_cn:'x'.repeat(101)}),
  good.map((c,i)=>i?c:{...c,image_url:'javascript:alert(1)'}),good.map((c,i)=>i?c:{...c,image_url:'https://x/'+'a'.repeat(500)}),
  good.map((c,i)=>i?c:{...c,air_date:'x'.repeat(21)}),good.map((c,i)=>i?c:{...c,score:11}),
  good.map((c,i)=>i?c:{...c,vote_count:-1}),'cards',null
 ];
 for(const cards of bad){const f=fixture();f.ready();assert.throws(()=>f.act(0,'start',{cards}),/牌组/);assert.equal(f.room.game,null);}
 const f=fixture();f.ready();
 f.act(0,'start',{cards:good.map((c,i)=>i?c:{...c,image_url:null,air_date:null,score:null})});
 assert.equal(f.state(0).game.phase,'clue');
});
test('start requires readiness and everyone connected, even within grace',()=>{
 const f=fixture();assert.throws(()=>f.act(0,'start',{cards:deal()}),/准备/);
 f.ready();f.drop(3);
 assert.ok(f.state(0).blockers.includes('等待离线玩家重连，或由房主移除'));
 assert.throws(()=>f.act(0,'start',{cards:deal()}),/离线/);
 f.back(3);f.act(0,'start',{cards:deal()});
 assert.throws(()=>f.seat(1,'blue','guesser'),/大厅/);
});
test('a newcomer mid-match watches with the full map and cannot act',()=>{
 const f=fixture();f.start();
 const late=core.join(f.room,'观众',f.now());f.players.push(late);f.back(4);
 const view=f.state(4),me=view.players.find(p=>p.id===late.id);
 assert.equal(me.team,null);assert.equal(me.inMatch,true);
 assert.ok(view.game.tiles.every(t=>t.type),'a spectator may switch to the captain map');
 assert.ok(f.state(1).game.tiles.some(t=>!t.type),'guessers still see a hidden map');
 assert.throws(()=>f.act(4,'clue',{word:'时间',count:1}),/队伍回合/);
 assert.throws(()=>f.act(4,'seat',{team:'red',role:'guesser'}),/大厅/);
 f.act(2,'clue',{word:'时间',count:1});
 assert.throws(()=>f.act(4,'vote',{choice:'end'}),/队伍回合/);
 assert.equal(f.state(4).threshold,1,'a spectator is not counted as a voter');
 // At the end they leave the review like everyone else and take a seat in the lobby.
 f.act(3,'vote',{choice:tilesOf(f,'assassin')[0]});
 for(const i of [0,1,2,3])f.act(i,'lobby');
 assert.ok(f.room.game,'the review waits for the spectator too');
 f.act(4,'lobby');assert.equal(f.room.game,null);
 f.act(4,'seat',{team:'red',role:'guesser'});
});
test('past the grace period only a seated match player is held; anyone else has left',()=>{
 const f=fixture();f.start();
 const watcher=core.join(f.room,'观众',f.now()),online=new Set(f.players.map(p=>p.id));
 // Before the first connection the newcomer is kept, then let go at the grace boundary.
 const ghost=core.join(f.room,'未连接',f.now());
 core.presence(f.room,new Set([...online,watcher.id]),f.now());
 assert.ok(f.room.players.includes(watcher)&&f.room.players.includes(ghost));
 core.presence(f.room,online,f.now()+1);
 assert.ok(f.room.players.includes(watcher)&&!f.state(0).players.find(p=>p.id===watcher.id).away,'a reload keeps the spectator');
 assert.equal(core.nextWake(f.room),f.now()+GRACE);
 core.presence(f.room,online,f.now()+GRACE);
 assert.ok(!f.room.players.includes(ghost),'a newcomer who never connects is let go');
 assert.ok(f.room.players.includes(watcher));
 core.presence(f.room,online,f.now()+1+GRACE);
 assert.ok(!f.room.players.includes(watcher),'a spectator who stays gone leaves the room');
 assert.equal(core.departure(f.room,watcher.token),'timeout');
 assert.equal(f.room.players.length,4);assert.ok(f.room.game,'the match goes on');
 // A seated player who drops still gets their seat held, for as long as the match lasts.
 f.drop(3);f.tick(GRACE*100);assert.ok(f.state(0).players.find(p=>p.id===f.players[3].id).away);
 assert.equal(core.departure(f.room,f.players[3].token),null);
});
test('the end of a match lets go of the away players it held',()=>{
 const f=fixture(5);f.start();f.drop(4);f.tick(GRACE);
 assert.equal(f.room.players.length,5);
 f.act(2,'clue',{word:'时间',count:1});f.act(3,'vote',{choice:tilesOf(f,'assassin')[0]});
 assert.equal(f.room.game.phase,'over');
 assert.equal(f.room.players.length,4,'the review screen holds no seat');
 assert.equal(core.departure(f.room,f.players[4].token),'timeout');
});
test('a room nobody is connected to is dissolved, even mid-match',()=>{
 const f=fixture();f.start();
 for(let i=0;i<4;i++)f.drop(i);
 const last=f.now();f.tick(GRACE);
 assert.equal(f.room.players.length,4,'the match holds every seat');
 assert.equal(core.nextWake(f.room),last+core.options.abandonMs);
 assert.equal(core.expired(f.room,last+core.options.abandonMs-1),false);
 assert.equal(core.expired(f.room,last+core.options.abandonMs),true);
 // One player back in time keeps the room.
 f.back(2);assert.equal(core.expired(f.room,last+core.options.abandonMs),false);
});
test('a retried join from the same browser gets the same member back',()=>{
 const f=fixture();f.start();
 const client='c'.repeat(32);
 // The answer to the first join was lost, so the browser asks again.
 const first=core.join(f.room,'观众',f.now(),client),again=core.join(f.room,'观众2',f.now(),client);
 assert.equal(again,first);assert.equal(f.room.players.length,5);assert.equal(first.name,'观众2');
 assert.ok(core.snapshot(f.room,first,f.now()).players.every(p=>!('client' in p)),'the browser id stays private');
 // A seated player who comes back through the entry keeps their seat.
 const {room,player:host}=core.createRoom({code:'654321',id:'room-2',name:'房主',now:0,client:'h'.repeat(32)});
 core.action(room,host,{action:'seat',team:'red',role:'captain'},0);
 assert.equal(core.join(room,'房主',1,'h'.repeat(32)),host);assert.equal(host.team,'red');
 // Without an id, or with a malformed one, every join is a new member.
 assert.notEqual(core.join(f.room,'观众',f.now()),core.join(f.room,'观众',f.now()));
 assert.notEqual(core.join(f.room,'观众',f.now(),'x'),core.join(f.room,'观众',f.now(),'x'));
});
test('a spectator leaving never ends the match',()=>{
 const f=fixture();f.start();
 const late=core.join(f.room,'观众',f.now());f.players.push(late);f.back(4);
 f.act(4,'leave');assert.equal(f.room.game.phase,'clue');
});
test('settings validate filters and rules without counting the pool',()=>{
 const f=fixture();f.ready();
 f.act(0,'settings',{filters:{...f.state(0).settings.filters,minVotes:999999}});
 assert.equal(f.state(0).settings.filters.minVotes,999999,'the server no longer knows the pool size');
 assert.ok(f.state(0).players.every(p=>p.ready));
 const filters=f.state(0).settings.filters;
 for(const change of [{minScore:7.05},{maxScore:11},{minScore:9,maxScore:8},{included:['']},{excluded:[42]},{excludeOptions:'bad'},{maxYear:G.dataYear+1}])
  assert.throws(()=>f.act(0,'settings',{filters:{...filters,...change}}));
 assert.throws(()=>f.act(0,'settings',{voting:'always'}),/投票规则/);
 assert.throws(()=>f.act(0,'settings',{rules:{turnSeconds:45}}),/回合限时/);
 assert.throws(()=>f.act(0,'settings',{rules:{maxFlips:'两张'}}),/翻牌上限/);
 assert.throws(()=>f.act(0,'settings',{rules:{banMode:'twice'}}),/禁牌次数/);
 f.act(0,'settings',{rules:{ban:true}});f.act(0,'settings',{rules:{turnSeconds:90}});
 assert.deepEqual(f.state(0).settings.rules,{maxFlips:'clue',freeCount:true,ban:true,banMode:'game',turnSeconds:90});
 f.act(0,'settings',{rules:{banMode:'round'}});assert.equal(f.state(0).settings.rules.banMode,'round');
 f.act(0,'settings',{rules:{turnSeconds:null}});assert.equal(f.state(0).settings.rules.turnSeconds,null);
});
test('voting: strict majority, changing votes and stale requests',()=>{
 const f=fixture(6);f.act(0,'settings',{voting:'majority'});f.start();
 assert.throws(()=>f.act(0,'clue',{word:'时间',count:2}),/回合/);
 assert.throws(()=>f.act(3,'clue',{word:'时间',count:2}),/队长/);
 f.act(2,'clue',{word:'时间',count:2});assert.throws(()=>f.act(2,'vote',{choice:0}),/猜词人/);
 const [blue]=tilesOf(f,'blue'),[neutral]=tilesOf(f,'neutral');
 f.act(3,'vote',{choice:blue});assert.equal(f.state(3).game.tiles[blue].revealed,false);
 f.act(3,'vote',{choice:null});assert.deepEqual(f.state(3).votes,{});
 f.act(3,'vote',{choice:blue});const epoch=f.room.epoch;f.act(4,'vote',{choice:blue});
 assert.equal(f.state(3).game.tiles[blue].revealed,true);assert.deepEqual(f.state(3).votes,{});
 assert.throws(()=>core.action(f.room,f.players[5],{action:'vote',choice:neutral,epoch},f.now()),/已更新/);
});
test('unanimous waits for everyone and end is a vote',()=>{
 const f=fixture(5);f.start();f.act(2,'clue',{word:'时间',count:1});
 f.act(3,'vote',{choice:0});f.act(4,'vote',{choice:'end'});assert.equal(f.state(3).game.phase,'guess');
 f.act(3,'vote',{choice:'end'});assert.equal(f.state(3).game.turn,'red');assert.equal(f.state(3).game.clue,null);
});
test('the ban rule is unchanged',()=>{
 const f=fixture();f.act(0,'settings',{rules:{ban:true}});f.start();
 const blues=tilesOf(f,'blue');
 assert.throws(()=>f.act(3,'ban',{index:0}),/队长/);
 f.act(2,'ban',{index:blues[1]});
 assert.equal(f.state(0).game.banned.blue,blues[1]);assert.equal(f.state(3).game.banned.blue,null);
 f.act(2,'clue',{word:'时间',count:3});assert.throws(()=>f.act(2,'ban',{index:blues[2]}),/出题阶段/);
});
test('a one-ban room keeps the spent ban live and tells only the captains',()=>{
 const f=fixture();f.act(0,'settings',{rules:{ban:true}});f.start();
 assert.equal(f.state(3).game.rules.banMode,'game');
 const blues=tilesOf(f,'blue'),[neutral]=tilesOf(f,'neutral');
 f.act(2,'ban',{index:blues[1]});f.act(2,'clue',{word:'时间',count:1});
 for(const i of [0,2])assert.deepEqual(f.state(i).game.banUsed,{red:false,blue:true});
 for(const i of [1,3])assert.deepEqual(f.state(i).game.banUsed,{red:false,blue:false},'a guesser is not told a ban is live');
 f.act(3,'vote',{choice:'end'});f.act(0,'clue',{word:'机器人',count:1});f.act(1,'vote',{choice:neutral});
 assert.equal(f.state(2).game.turn,'blue');assert.equal(f.state(2).game.banned.blue,blues[1],'the spent ban is still live');
 assert.throws(()=>f.act(2,'ban',{index:blues[2]}),/禁牌无效/);
 assert.throws(()=>f.act(2,'ban',{index:null}),/禁牌无效/);
});
test('the per-round ban mode clears the ban when its captain is back on the clue',()=>{
 const f=fixture();f.act(0,'settings',{rules:{ban:true,banMode:'round'}});f.start();
 const blues=tilesOf(f,'blue'),[neutral]=tilesOf(f,'neutral');
 f.act(2,'ban',{index:blues[1]});f.act(2,'clue',{word:'时间',count:1});
 f.act(3,'vote',{choice:'end'});f.act(0,'clue',{word:'机器人',count:1});f.act(1,'vote',{choice:neutral});
 assert.equal(f.state(2).game.banned.blue,null);assert.deepEqual(f.state(2).game.banUsed,{red:false,blue:false});
 f.act(2,'ban',{index:blues[2]});assert.equal(f.state(2).game.banned.blue,blues[2]);
});
test('a room saved before the ban mode existed picks up the default',()=>{
 const f=fixture();delete f.room.settings.rules.banMode;
 f.act(0,'settings',{rules:{ban:true}});assert.equal(f.state(0).settings.rules.banMode,'game');
 delete f.room.settings.rules.banMode;f.start();assert.equal(f.room.game.rules.banMode,'game');
});
test('a short drop changes nothing; only away players are shown and stop counting',()=>{
 const f=fixture(5);f.start();f.act(2,'clue',{word:'时间',count:2});
 f.act(4,'vote',{choice:'end'});f.drop(4);
 assert.equal(f.state(3).players[4].away,false);assert.equal(f.state(3).threshold,2);
 assert.equal(f.tick(GRACE-1),false,'nothing visible changes within grace');
 assert.equal(f.tick(1),true);
 assert.equal(f.state(3).players[4].away,true);assert.equal(f.state(3).threshold,1);
 assert.equal(f.state(3).game.turn,'blue','an away vote does not count');
 f.back(4);assert.equal(f.state(3).players[4].away,false);assert.equal(f.state(3).threshold,2);
});
test('an away guesser no longer stalls a unanimous vote',()=>{
 const f=fixture(5);f.start();f.act(2,'clue',{word:'时间',count:2});
 f.act(3,'vote',{choice:'end'});assert.equal(f.state(3).game.phase,'guess');
 f.drop(4);f.tick(GRACE-1);assert.equal(f.state(3).game.turn,'blue');
 f.tick(1);
 assert.equal(f.state(3).game.turn,'red','the waiting vote executes once player 4 is away');
 assert.deepEqual(f.state(3).votes,{});
});
test('a lobby drop keeps the seat and readiness through a reload, then the player leaves',()=>{
 const f=fixture();f.ready();f.drop(1);f.tick(GRACE-1);
 assert.equal(f.state(0).players[1].ready,true);assert.equal(f.state(0).players[1].away,false);
 f.back(1);assert.deepEqual(f.state(0).blockers,[]);
 f.drop(1);f.tick(GRACE);
 assert.equal(f.room.players.length,3,'a lobby seat is not held');
 assert.equal(core.departure(f.room,f.players[1].token),'timeout');
 assert.ok(f.state(0).blockers.includes('红队至少需要一名猜词人'));
});
test('host passes to the first connected player once away, and stays there',()=>{
 const f=fixture(5);f.start();f.drop(0);f.drop(1);
 f.tick(GRACE-1);assert.equal(f.state(2).host,f.players[0].id);
 f.tick(1);assert.equal(f.state(2).host,f.players[2].id);
 f.back(0);f.back(1);assert.equal(f.state(0).host,f.players[2].id);
 // In the lobby the host leaves the room past the grace period, and the host goes with them.
 const g=fixture();g.drop(0);g.tick(GRACE);
 assert.equal(g.room.players.length,3);assert.equal(g.state(1).host,g.players[1].id);
});
test('the host can remove any other member, and removal keeps the match unless a team breaks',()=>{
 const f=fixture(5);f.start();
 assert.throws(()=>f.act(0,'kick',{player:f.players[0].id}),/自己/);
 assert.throws(()=>f.act(0,'kick',{player:'missing'}),/不在房间/);
 f.act(0,'kick',{player:f.players[4].id});
 assert.equal(core.departure(f.room,f.players[4].token),'kicked');
 assert.ok(f.state(0).game,'blue still has a guesser');assert.equal(f.state(0).players.length,4);
 assert.throws(()=>f.act(1,'kick',{player:f.players[3].id}),/房主/);
 f.drop(3);f.tick(GRACE);f.act(0,'kick',{player:f.players[3].id});
 assert.equal(f.state(0).game,null,'blue lost its last guesser');
 assert.ok(f.state(0).players.every(p=>!p.ready));
});
test('removing a captain mid-match returns the room to the lobby',()=>{
 const f=fixture(6);f.start();f.drop(2);f.tick(GRACE);f.act(0,'kick',{player:f.players[2].id});
 assert.equal(f.state(0).game,null);
});
test('leaving follows the same reset rule and hands over the host',()=>{
 const f=fixture(5);f.start();
 assert.deepEqual(f.act(4,'leave'),{left:true});assert.ok(f.state(0).game,'a spare guesser leaves quietly');
 assert.equal(core.departure(f.room,f.players[4].token),null,'leaving on purpose leaves nothing to come back to');
 f.act(0,'leave');assert.equal(f.room.game,null,'the red captain leaving ends the match');
 assert.equal(f.state(1).host,f.players[1].id);
 const solo=fixture(1);solo.act(0,'leave');assert.equal(core.expired(solo.room,solo.now()),true);
});
test('a leave or vote from an away teammate settles pending votes',()=>{
 const f=fixture(5);f.start();f.act(2,'clue',{word:'时间',count:2});
 f.act(3,'vote',{choice:'end'});f.act(4,'leave');
 assert.equal(f.state(3).game.turn,'red');
});
test('the review screen: each player leaves alone and away players do not hold it open',()=>{
 const f=fixture();f.start();f.act(2,'clue',{word:'时间',count:1});
 f.act(3,'vote',{choice:tilesOf(f,'assassin')[0]});
 assert.equal(f.state(1).game.winner,'red');
 const newcomer=core.join(f.room,'新成员',f.now());assert.equal(core.snapshot(f.room,newcomer,f.now()).game,null);
 f.players.push(newcomer);f.back(4);
 f.act(1,'lobby');assert.equal(f.state(1).game,null);assert.ok(f.state(0).game);
 f.drop(3);f.tick(GRACE);
 for(const i of [0,2])f.act(i,'lobby');
 assert.equal(f.room.game,null);assert.ok(f.state(0).players.every(p=>!p.inMatch));
});
test('an unfinished match is ended for everyone by the host alone',()=>{
 const f=fixture();f.start();assert.throws(()=>f.act(1,'lobby'),/房主/);
 f.act(0,'lobby');assert.equal(f.state(2).game,null);
});
test('the turn timer runs per phase and hands over on expiry',()=>{
 const f=fixture();f.act(0,'settings',{rules:{turnSeconds:60}});f.start();
 const t0=f.now();assert.equal(f.state(3).game.deadline,t0+60000);
 assert.equal(core.nextWake(f.room),t0+60000);
 f.tick(30000);f.act(2,'clue',{word:'时间',count:3});
 assert.equal(f.state(3).game.deadline,f.now()+60000,'a clue starts the guess clock');
 const [blue]=tilesOf(f,'blue');f.act(3,'vote',{choice:blue});
 assert.equal(f.state(3).game.deadline,t0+90000,'a correct card keeps the phase clock');
 const epoch=f.room.epoch;
 assert.equal(core.due(f.room,f.now()+59999),false);
 assert.equal(core.due(f.room,t0+90000),true);
 const g=f.state(0).game;
 assert.equal(g.turn,'red');assert.equal(g.phase,'clue');assert.match(g.history.at(-1),/蓝队超时/);
 assert.equal(f.room.epoch,epoch+1);assert.equal(g.deadline,t0+90000+60000);
});
test('an action after the deadline sees the timeout first',()=>{
 const f=fixture();f.act(0,'settings',{rules:{turnSeconds:60}});f.start();
 f.tick(0);const late=f.now()+60000;
 core.due(f.room,late);
 assert.throws(()=>core.action(f.room,f.players[2],{action:'clue',word:'迟到',count:1,epoch:f.room.epoch},late),/回合/);
});
test('without a timer there is no deadline',()=>{
 const f=fixture();f.start();f.act(2,'clue',{word:'时间',count:1});
 assert.equal(f.state(0).game.deadline,null);assert.equal(core.due(f.room,f.now()+1e9),false);
});
test('nextWake is the earliest of deadline, grace end and idle expiry',()=>{
 const f=fixture();const t=f.now();
 assert.equal(core.nextWake(f.room),t+core.options.idleMs);
 f.drop(3);assert.equal(core.nextWake(f.room),t+GRACE);
 f.tick(GRACE);assert.equal(f.room.players.length,3);assert.equal(core.nextWake(f.room),f.room.touched+core.options.idleMs,'a player who left needs no wake');
 const g=fixture();g.start();g.drop(3);g.tick(GRACE);
 assert.equal(core.nextWake(g.room),g.room.touched+core.options.idleMs,'an away match player needs no wake');
 assert.equal(core.expired(f.room,f.room.touched+core.options.idleMs-1),false);
 assert.equal(core.expired(f.room,f.room.touched+core.options.idleMs),true);
});
test('presence keeps the earlier disconnect time it is given',()=>{
 const f=fixture();f.start();const since={[f.players[1].id]:f.now()-GRACE};
 const online=new Set(f.players.filter((_,i)=>i!==1).map(p=>p.id));
 core.presence(f.room,online,f.now(),since);
 assert.equal(f.state(0).players[1].away,true);
 assert.equal(core.presence(f.room,online,f.now()),false,'nothing changes the second time');
});
test('chat: the lobby has only the public channel',()=>{
 const f=fixture();
 for(let i=0;i<4;i++)assert.deepEqual(f.state(i).chat,{hear:['public'],speak:['public']});
 const {message,to}=core.chat(f.room,f.players[1],{channel:'public',text:'  大家  好 '},f.now());
 assert.equal(message.text,'大家 好');assert.equal(message.name,'玩家1');assert.equal(message.team,'red');
 assert.deepEqual(to.sort(),f.players.map(p=>p.id).sort());
 assert.throws(()=>core.chat(f.room,f.players[0],{channel:'captain',text:'hi'},f.now()),/频道/);
 assert.throws(()=>core.chat(f.room,f.players[1],{channel:'red',text:'hi'},f.now()),/频道/);
});
test('chat: captains share a channel, each team\'s guessers have their own, spectators only get public',()=>{
 const f=fixture(5);f.start();
 const late=core.join(f.room,'观众',f.now());f.players.push(late);f.back(5);
 const [rc,rg,bc,bg,bg2,watcher]=f.players;
 const ids=list=>list.map(p=>p.id).sort();
 const send=(p,channel)=>core.chat(f.room,p,{channel,text:'x'},f.now()).to.sort();
 assert.deepEqual(f.state(0).chat,{hear:['public','captain'],speak:['public','captain']});
 assert.deepEqual(f.state(3).chat,{hear:['public','blue'],speak:['public','blue']});
 assert.deepEqual(f.state(5).chat,{hear:['public'],speak:['public']});
 assert.deepEqual(send(rc,'captain'),ids([rc,bc]));
 assert.deepEqual(send(bg,'blue'),ids([bg,bg2]));
 assert.deepEqual(send(rg,'red'),ids([rg]));
 assert.deepEqual(send(rc,'public'),ids(f.players));
 assert.throws(()=>send(rg,'blue'),/频道/);
 assert.throws(()=>send(rg,'captain'),/频道/);
 assert.throws(()=>send(rc,'red'),/频道/,'a captain does not reach the guessers\' channel');
 assert.throws(()=>send(watcher,'captain'),/频道/,'a spectator only speaks in public');
});
test('chat: text is checked and the length is capped',()=>{
 const f=fixture();
 for(const text of ['',' ',null,42])assert.throws(()=>core.chat(f.room,f.players[0],{channel:'public',text},f.now()),/不能为空/);
 assert.equal(core.chat(f.room,f.players[0],{channel:'public',text:'字'.repeat(core.CHAT_MAX)},f.now()).message.text.length,core.CHAT_MAX);
 assert.throws(()=>core.chat(f.room,f.players[0],{channel:'public',text:'字'.repeat(core.CHAT_MAX+1)},f.now()),/最多/);
 assert.throws(()=>core.chat(f.room,f.players[0],{channel:'nope',text:'hi'},f.now()),/频道/);
});
test('chat: a player back in the lobby after the match only has the public channel',()=>{
 const f=fixture();f.start();
 f.act(2,'clue',{word:'时间',count:1});f.act(3,'vote',{choice:tilesOf(f,'assassin')[0]});
 assert.deepEqual(f.state(0).chat.hear,['public','captain'],'the review screen keeps the match channels');
 f.act(0,'lobby');
 assert.deepEqual(f.state(0).chat,{hear:['public'],speak:['public']});
 assert.ok(!core.chat(f.room,f.players[2],{channel:'captain',text:'x'},f.now()).to.includes(f.players[0].id));
});
test('rooms start private; only the host opens one to the public list, which shows its seats and match',()=>{
 const f=fixture(5);
 assert.equal(f.state(0).public,false);assert.equal(core.listing(f.room),null);
 assert.throws(()=>f.act(1,'publicRoom',{public:true}),/房主/);
 assert.throws(()=>f.act(0,'publicRoom',{public:'yes'}),/无效/);
 f.act(0,'publicRoom',{public:true});
 for(let i=0;i<5;i++)assert.equal(f.state(i).public,true);
 assert.deepEqual(core.listing(f.room),{code:'123456',host:'玩家0',players:5,seated:5,max:core.MAX_PLAYERS,playing:false});
 const guest=core.join(f.room,'旁观者',f.now());
 assert.equal(core.listing(f.room).players,6);assert.equal(core.listing(f.room).seated,5);
 core.action(f.room,guest,{action:'leave'},f.now());assert.equal(core.listing(f.room).players,5);
 f.start();assert.equal(core.listing(f.room).playing,true);
 // The setting outlives a host transfer, and the next host can close the room again.
 f.act(0,'leave');assert.equal(f.room.public,true);assert.equal(core.listing(f.room).host,'玩家1');
 assert.equal(f.state(1).host,f.players[1].id);
 f.act(1,'publicRoom',{public:false});assert.equal(core.listing(f.room),null);
});
