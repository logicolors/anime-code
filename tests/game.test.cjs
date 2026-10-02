const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../game.js');
const pool=Array.from({length:30},(_,id)=>({id,name_cn:'动画'+id}));
// The default flip budget is the clue number plus one, so a test that wants to
// keep turning cards over says so with a larger number.
const ready=(count=3,rules)=>{const g=G.create(pool,Math.random,'red',rules);G.giveClue(g,'时间',count);return g;};
test('25 unique cards and 9/8/7/1 roles',()=>{const g=G.create(pool);assert.equal(new Set(g.tiles.map(t=>t.anime.id)).size,25);for(const [role,n] of Object.entries({red:9,blue:8,neutral:7,assassin:1}))assert.equal(g.tiles.filter(t=>t.type===role).length,n);});
test('cannot guess before a valid clue',()=>{const g=G.create(pool);assert.equal(G.guess(g,0),null);assert.equal(G.giveClue(g,' ',3),false);assert.equal(G.giveClue(g,'词 语',3),false);assert.equal(G.giveClue(g,'词',-1),false);assert.equal(G.giveClue(g,'词',1.5),false);});
test('clue count accepts 0 and values above remaining cards',()=>{for(const n of [0,10,99]){const g=G.create(pool);assert.equal(G.giveClue(g,'词',n),true);assert.equal(g.clue.count,n);}});
test('own card continues and cannot be counted twice',()=>{const g=ready(),i=g.tiles.findIndex(t=>t.type==='red');G.guess(g,i);assert.equal(g.phase,'guess');assert.equal(G.remaining(g,'red'),8);assert.equal(G.guess(g,i),null);});
test('opponent card is credited, switches turn, clears clue',()=>{const g=ready();G.guess(g,g.tiles.findIndex(t=>t.type==='blue'));assert.equal(G.remaining(g,'blue'),7);assert.equal(g.turn,'blue');assert.equal(g.phase,'clue');assert.equal(g.clue,null);});
test('neutral and voluntary stop both switch turn',()=>{for(const voluntary of [true,false]){const g=ready();if(voluntary)G.stop(g);else G.guess(g,g.tiles.findIndex(t=>t.type==='neutral'));assert.equal(g.turn,'blue');assert.equal(g.round,2);assert.equal(G.remaining(g,'red'),9);}});
test('opponent last card wins for opponent',()=>{const g=ready(),blues=g.tiles.filter(t=>t.type==='blue');blues.slice(0,-1).forEach(t=>t.revealed=true);G.guess(g,g.tiles.indexOf(blues.at(-1)));assert.equal(g.winner,'blue');assert.equal(g.phase,'over');});
test('own last card wins',()=>{const g=ready(99);g.tiles.filter(t=>t.type==='red').forEach(t=>G.guess(g,g.tiles.indexOf(t)));assert.equal(g.winner,'red');});
test('assassin loses and all actions remain locked afterward',()=>{const g=ready();G.guess(g,g.tiles.findIndex(t=>t.type==='assassin'));assert.equal(g.winner,'blue');const snapshot=JSON.stringify(g);assert.equal(G.stop(g),false);assert.equal(G.giveClue(g,'词',1),false);assert.equal(G.guess(g,0),null);assert.equal(JSON.stringify(g),snapshot);});
test('filter respects dates, votes, tags, banned IDs and duplicate names',()=>{const base={vote_count:3000,air_date:'2020-01-01',tags:[],score:8};const data=[{...base,id:1,name_cn:'有效'},{...base,id:2,name_cn:'有效'},{...base,id:3,name_cn:'低票',vote_count:3},{...base,id:4,name_cn:'国产',tags:['国产']},{...base,id:5,name_cn:'未来',air_date:'2026-08-01'},{...base,id:150955,name_cn:'排除'}];assert.deepEqual(G.filter(data).map(a=>a.id),[1]);});
test('filter applies inclusive 0–10 score bounds',()=>{
 const base={vote_count:3000,air_date:'2020-01-01',tags:[],name_cn:''};
 const data=[{...base,id:1,name_cn:'low',score:7.9},{...base,id:2,name_cn:'min',score:8},{...base,id:3,name_cn:'max',score:9},{...base,id:4,name_cn:'high',score:9.1},{...base,id:5,name_cn:'unknown',score:null}];
 assert.deepEqual(G.filter(data,{minScore:8,maxScore:9,excluded:[],included:[]}).map(a=>a.id),[2,3]);
});
test('score bounds read Bangumi scores directly instead of rescaling them',()=>{
 const base={vote_count:3000,air_date:'2020-01-01',tags:[]};
 const data=[{...base,id:1,name_cn:'八分二',score:8.2}];
 assert.deepEqual(G.filter(data,{minScore:8,maxScore:9}).map(a=>a.id),[1]);
 assert.deepEqual(G.filter(data,{minScore:9}).map(a=>a.id),[]);
 assert.equal(G.defaults.maxScore,10);
 assert.deepEqual(G.filter(data,{minScore:0,maxScore:11}),[]);
});
test('turn banners name the acting side and role, and stay silent without a change',()=>{
 const g=G.create(pool);
 assert.equal(G.actorText(g),'红队队长行动');
 assert.deepEqual(G.announcement(null,g),{team:'red',title:'红队队长行动',detail:'红队先手 · 第 1 回合'});
 const beforeClue={...g};G.giveClue(g,'时间',3);
 assert.deepEqual(G.announcement(beforeClue,g),{team:'red',title:'红队猜词人行动',detail:'提示「时间」 · 3 张'});
 assert.equal(G.announcement({...g},g),null);
 const beforeStop={...g};G.stop(g);
 assert.deepEqual(G.announcement(beforeStop,g),{team:'blue',title:'蓝队队长行动',detail:'第 2 回合'});
 assert.equal(G.announcement(beforeStop,null),null);
 g.phase='over';assert.equal(G.announcement(beforeStop,g),null);
});
test('a blue opening announces the blue captain',()=>{
 const g=G.create(pool,Math.random,'blue');
 assert.equal(G.actorText(g),'蓝队队长行动');
 assert.deepEqual(G.announcement(null,g),{team:'blue',title:'蓝队队长行动',detail:'蓝队先手 · 第 1 回合'});
});
test('the dataset cutoff drives the newest selectable year',()=>{
 assert.match(G.dataDate,/^\d{4}-\d{2}-\d{2}$/);
 assert.equal(G.dataYear,Number(G.dataDate.slice(0,4)));
 assert.equal(G.defaults.maxYear,G.dataYear);
});
test('pool presets only move the numeric dials and stay inside the server bounds',()=>{
 assert.ok(G.presets.length>=4);
 assert.deepEqual(G.presetKeys,['minVotes','minYear','maxYear','minScore','maxScore']);
 for(const {name,hint,filters} of G.presets){
  assert.ok(name&&hint,'every chip needs a label and a hint');
  assert.deepEqual(Object.keys(filters).sort(),[...G.presetKeys].sort(),`${name} must set exactly the numeric dials`);
  assert.ok(Number.isInteger(filters.minVotes)&&filters.minVotes>=0);
  assert.ok(Number.isInteger(filters.minYear)&&filters.minYear>=0&&filters.minYear<=G.dataYear);
  assert.ok(Number.isInteger(filters.maxYear)&&filters.maxYear>=1996&&filters.maxYear<=G.dataYear);
  assert.ok(filters.minYear<=filters.maxYear&&filters.minScore<=filters.maxScore);
  for(const key of ['minScore','maxScore'])
   assert.ok(filters[key]>=0&&filters[key]<=10&&Math.abs(Math.round(filters[key]*10)-filters[key]*10)<1e-6);
 }
});
test('the clue number plus one bounds the round, and running out ends it',()=>{
 const g=ready(1);
 assert.equal(G.flipLimit(g),2);assert.equal(G.flipsLeft(g),2);
 const reds=g.tiles.filter(t=>t.type==='red');
 G.guess(g,g.tiles.indexOf(reds[0]));
 assert.equal(g.phase,'guess');assert.equal(G.flipsLeft(g),1);
 G.guess(g,g.tiles.indexOf(reds[1]));
 assert.equal(g.turn,'blue');assert.equal(g.round,2);assert.equal(g.phase,'clue');
 assert.equal(G.remaining(g,'red'),7,'both correct cards still count');
 assert.match(g.history.at(-1),/用完了本轮翻牌次数/);
 assert.equal(G.flipLimit(g),Infinity,'a round without a clue has no budget yet');
});
test('an unlimited room and a clue without a number both lift the flip budget',()=>{
 for(const g of [ready(1,{maxFlips:'unlimited'}),ready(null)]){
  assert.equal(G.flipLimit(g),Infinity);assert.equal(G.flipsLeft(g),Infinity);
  const reds=g.tiles.filter(t=>t.type==='red');
  for(const tile of reds.slice(0,4))G.guess(g,g.tiles.indexOf(tile));
  assert.equal(g.phase,'guess');assert.equal(G.remaining(g,'red'),5);
 }
});
test('a blank clue number needs the room to allow it and reads as unlimited',()=>{
 const strict=G.create(pool,Math.random,'red',{freeCount:false});
 assert.equal(G.giveClue(strict,'时间',null),false);
 assert.equal(strict.phase,'clue');
 const g=G.create(pool);
 assert.equal(G.giveClue(g,'时间',null),true);
 assert.equal(g.clue.count,null);
 assert.match(g.history.at(-1),/提示：时间 · 不限/);
 assert.deepEqual(G.announcement({...g,phase:'clue'},g),{team:'red',title:'红队猜词人行动',detail:'提示「时间」 · 不限张数'});
});
test('a banned card is only bannable by the clue-giver and ends the round when taken',()=>{
 const off=ready(3);
 assert.equal(G.ban(off,0),false,'the rule is off by default');
 const g=G.create(pool,Math.random,'red',{ban:true});
 const reds=g.tiles.filter(t=>t.type==='red').map(t=>g.tiles.indexOf(t));
 assert.equal(G.ban(g,reds[0]),true);assert.deepEqual(g.banned,{red:reds[0],blue:null});
 assert.equal(G.ban(g,null),true);assert.deepEqual(g.banned,{red:null,blue:null});
 G.ban(g,reds[0]);
 G.giveClue(g,'时间',3);
 assert.equal(G.ban(g,reds[1]),false,'the ban is locked once the clue is out');
 assert.equal(g.banned.red,reds[0]);
 G.guess(g,reds[1]);assert.equal(g.phase,'guess','an ordinary correct card keeps the turn');
 G.guess(g,reds[0]);
 assert.equal(G.remaining(g,'red'),7,'the banned card is still credited');
 assert.equal(g.turn,'blue');assert.equal(g.round,2);
 assert.match(g.history.at(-1),/红队翻到红队禁用牌/);
 assert.equal(g.banned.red,reds[0],'the turned-over card keeps its mark through the blue turn');
 G.giveClue(g,'机器人',1);G.stop(g);
 assert.equal(g.turn,'red');assert.equal(g.banned.red,null,'the live ban clears when the red captain is back on the clue');
 assert.equal(G.bannedBy(g,reds[0]),'red','the turned-over card keeps its mark for the rest of the game');
 assert.equal(G.ban(g,reds[0]),false,'and it cannot be banned again');
});
test('a ban lasts through the other turn until the same captain gives the next clue',()=>{
 const g=G.create(pool,Math.random,'red',{ban:true});
 const of=type=>g.tiles.flatMap((t,i)=>t.type===type?[i]:[]);
 const reds=of('red'),blues=of('blue'),neutral=of('neutral');
 G.ban(g,blues[0]);G.giveClue(g,'时间',1);G.stop(g);
 assert.equal(g.turn,'blue');assert.equal(g.banned.red,blues[0],'the red ban carries into the blue turn');
 assert.equal(G.bannedBy(g,blues[0]),'red');
 assert.equal(G.ban(g,blues[0]),false,'a card the other team banned cannot be banned again');
 G.ban(g,reds[0]);assert.deepEqual(g.banned,{red:blues[0],blue:reds[0]},'both bans are live at once');
 G.giveClue(g,'机器人',3);
 G.guess(g,blues[1]);assert.equal(g.phase,'guess');
 G.guess(g,blues[0]);
 assert.equal(g.turn,'red','the red ban costs blue the rest of its round');
 assert.match(g.history.at(-1),/蓝队翻到红队禁用牌/);
 assert.deepEqual(g.banned,{red:null,blue:reds[0]},'the blue ban now runs through the red turn');
 G.giveClue(g,'时间',1);G.guess(g,neutral[0]);
 assert.equal(g.turn,'blue');assert.deepEqual(g.banned,{red:null,blue:null},'the ban clears when its captain is back on the clue');
 assert.equal(G.bannedBy(g,blues[0]),'red','a card turned over under the opposing ban keeps that mark');
 assert.equal(G.bannedBy(g,reds[0]),null,'an unflipped ban leaves no mark once it clears');
});
test('a revealed card cannot be banned',()=>{
 const g=G.create(pool,Math.random,'red',{ban:true});
 g.tiles[0].revealed=true;
 assert.equal(G.ban(g,0),false);assert.equal(G.ban(g,99),false);assert.deepEqual(g.banned,{red:null,blue:null});
});
test('pool presets keep the vote floors the lobby advertises',()=>{
 assert.equal(G.defaults.minVotes,2500);
 assert.ok(!G.presets.some(p=>p.name==='全部'),'an unfiltered pool is no longer offered');
 const by=Object.fromEntries(G.presets.map(p=>[p.name,p.filters]));
 assert.equal(by['热门'].minVotes,5000);
 assert.deepEqual([by['人气佳作'].minVotes,by['人气佳作'].minScore],[2500,7]);
 assert.deepEqual([by['经典高分'].minVotes,by['经典高分'].minScore],[2000,7.5]);
 assert.equal(by['近五年'].minVotes,1000);assert.equal(by['近十年'].minVotes,1000);
});
test('filter requires every included tag and rejects excluded tags',()=>{
 const base={vote_count:3000,air_date:'2020-01-01',score:8};
 const data=[
  {...base,id:1,name_cn:'both',tags:['hero','school']},
  {...base,id:2,name_cn:'one',tags:['hero']},
  {...base,id:3,name_cn:'blocked',tags:['hero','school','OVA']},
  {...base,id:4,name_cn:'other',tags:['school']}
 ];
 assert.deepEqual(G.filter(data,{minScore:0,maxScore:10,excluded:['OVA'],included:['hero','school']}).map(a=>a.id),[1]);
});
test('a timeout hands the turn over from either phase and is logged',()=>{
 const g=G.create(pool,Math.random,'red');
 assert.equal(G.timeout(g),true);
 assert.equal(g.turn,'blue');assert.equal(g.round,2);assert.equal(g.phase,'clue');assert.equal(g.history.at(-1),'第 1 回合 · 红队超时');
 G.giveClue(g,'时间',2);G.guess(g,g.tiles.findIndex(t=>t.type==='blue'));
 assert.equal(G.timeout(g),true);
 assert.equal(g.turn,'red');assert.equal(g.phase,'clue');assert.equal(g.clue,null);assert.equal(g.flips,0);assert.equal(g.history.at(-1),'第 2 回合 · 蓝队超时');
 G.giveClue(g,'时间',1);G.guess(g,g.tiles.findIndex(t=>t.type==='assassin'));
 const over=JSON.stringify(g);assert.equal(G.timeout(g),false);assert.equal(JSON.stringify(g),over);
});
