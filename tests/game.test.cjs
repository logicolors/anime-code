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
 assert.deepEqual(g.turns,[{team:'red',round:1,word:'时间',count:1,flips:reds.slice(0,2).map(t=>g.tiles.indexOf(t))}]);
 assert.equal(G.flipLimit(g),Infinity,'a round without a clue has no budget yet');
});
test('each team turn is recorded with its clue and the cards in the order they were turned',()=>{
 const g=G.create(pool,Math.random,'red');
 const of=type=>g.tiles.flatMap((t,i)=>t.type===type?[i]:[]);
 const reds=of('red'),blues=of('blue'),neutral=of('neutral');
 assert.deepEqual(g.turns,[]);
 G.giveClue(g,'时间',2);G.guess(g,reds[0]);G.guess(g,reds[1]);G.stop(g);
 G.giveClue(g,'机器人',3);G.guess(g,blues[0]);G.guess(g,neutral[0]);
 assert.equal(G.guess(g,reds[2]),null,'a card turned outside the guess phase is not recorded');
 G.giveClue(g,'魔法',1);G.guess(g,blues[1]);
 assert.deepEqual(g.turns,[
  {team:'red',round:1,word:'时间',count:2,flips:[reds[0],reds[1]]},
  {team:'blue',round:2,word:'机器人',count:3,flips:[blues[0],neutral[0]]},
  {team:'red',round:3,word:'魔法',count:1,flips:[blues[1]]}
 ]);
 // A game stored before the record existed picks it up from its next clue.
 const red=g=>g.tiles.findIndex(t=>t.type==='red');
 const old=G.create(pool,Math.random,'red');delete old.turns;
 G.giveClue(old,'时间',1);G.guess(old,red(old));
 assert.deepEqual(old.turns,[{team:'red',round:1,word:'时间',count:1,flips:[old.tiles.findIndex(t=>t.revealed)]}]);
 const mid=G.create(pool,Math.random,'red');G.giveClue(mid,'时间',1);delete mid.turns;
 assert.equal(G.guess(mid,red(mid))?.type,'red');assert.equal(mid.turns,undefined);
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
 assert.deepEqual(g.turns,[{team:'red',round:1,word:'时间',count:null,flips:[]}]);
 assert.deepEqual(G.announcement({...g,phase:'clue'},g),{team:'red',title:'红队猜词人行动',detail:'提示「时间」 · 不限张数'});
});
test('a banned card is only bannable by the clue-giver and ends the round when taken',()=>{
 const off=ready(3);
 assert.equal(G.ban(off,0),false,'the rule is off by default');
 assert.equal(off.rules.banMode,'game','one ban per game is the default');
 const g=G.create(pool,Math.random,'red',{ban:true,banMode:'round'});
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
 assert.deepEqual(g.turns.at(-1).flips,[reds[1],reds[0]]);
 assert.equal(g.banned.red,reds[0],'the turned-over card keeps its mark through the blue turn');
 G.giveClue(g,'机器人',1);G.stop(g);
 assert.equal(g.turn,'red');assert.equal(g.banned.red,null,'the live ban clears when the red captain is back on the clue');
 assert.equal(G.bannedBy(g,reds[0]),'red','the turned-over card keeps its mark for the rest of the game');
 assert.equal(G.ban(g,reds[0]),false,'and it cannot be banned again');
});
test('a ban lasts through the other turn until the same captain gives the next clue',()=>{
 const g=G.create(pool,Math.random,'red',{ban:true,banMode:'round'});
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
 assert.deepEqual(g.turns.at(-1),{team:'blue',round:2,word:'机器人',count:3,flips:[blues[1],blues[0]]});
 assert.deepEqual(g.banned,{red:null,blue:reds[0]},'the blue ban now runs through the red turn');
 G.giveClue(g,'时间',1);G.guess(g,neutral[0]);
 assert.equal(g.turn,'blue');assert.deepEqual(g.banned,{red:null,blue:null},'the ban clears when its captain is back on the clue');
 assert.equal(G.bannedBy(g,blues[0]),'red','a card turned over under the opposing ban keeps that mark');
 assert.equal(G.bannedBy(g,reds[0]),null,'an unflipped ban leaves no mark once it clears');
});
test('a one-ban game spends the ban that is still standing when the clue phase ends',()=>{
 const g=G.create(pool,Math.random,'red',{ban:true,banMode:'game'});
 const of=type=>g.tiles.flatMap((t,i)=>t.type===type?[i]:[]);
 const reds=of('red'),blues=of('blue'),neutral=of('neutral');
 // Moving or lifting it during the clue phase costs nothing.
 G.ban(g,reds[0]);G.ban(g,null);G.ban(g,reds[1]);
 assert.deepEqual(g.banUsed,{red:false,blue:false});
 G.giveClue(g,'时间',1);
 assert.deepEqual(g.banUsed,{red:true,blue:false});
 G.stop(g);
 // Blue skips its ban, so it keeps the chance for a later round.
 G.giveClue(g,'机器人',1);
 assert.deepEqual(g.banUsed,{red:true,blue:false});
 G.guess(g,neutral[0]);
 assert.equal(g.turn,'red');assert.equal(g.banned.red,reds[1],'a spent ban stays live into later rounds');
 assert.equal(G.ban(g,reds[2]),false,'and the captain cannot ban another card');
 assert.equal(G.ban(g,null),false,'or lift it');
 G.giveClue(g,'时间',2);G.guess(g,reds[0]);G.guess(g,reds[1]);
 assert.equal(g.turn,'blue','the spent ban still ends the round when taken');
 assert.equal(G.bannedBy(g,reds[1]),'red');
 assert.equal(G.ban(g,blues[0]),true,'blue still holds its one ban');
 G.timeout(g);
 assert.deepEqual(g.banUsed,{red:true,blue:true},'running out the clue clock with a ban held spends it too');
 G.giveClue(g,'时间',1);G.stop(g);
 assert.equal(g.banned.blue,blues[0]);assert.equal(G.ban(g,blues[1]),false);
});
test('a game without a ban mode keeps resetting the ban every round',()=>{
 const g=G.create(pool,Math.random,'red',{ban:true});delete g.rules.banMode;delete g.banUsed;
 const reds=g.tiles.flatMap((t,i)=>t.type==='red'?[i]:[]);
 G.ban(g,reds[0]);G.giveClue(g,'时间',1);G.stop(g);G.giveClue(g,'机器人',1);G.stop(g);
 assert.equal(g.banned.red,null);assert.equal(G.ban(g,reds[1]),true);
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
test('a timeout hands the turn over from either phase and is recorded',()=>{
 const g=G.create(pool,Math.random,'red');
 assert.equal(G.timeout(g),true);
 assert.equal(g.turn,'blue');assert.equal(g.round,2);assert.equal(g.phase,'clue');assert.deepEqual(g.turns,[{team:'red',round:1,word:null,count:null,flips:[]}],'a clue phase that ran out is a turn without a word');
 G.giveClue(g,'时间',2);G.guess(g,g.tiles.findIndex(t=>t.type==='blue'));
 assert.equal(G.timeout(g),true);
 assert.equal(g.turn,'red');assert.equal(g.phase,'clue');assert.equal(g.clue,null);assert.equal(g.flips,0);assert.equal(g.turns.length,2,'a guess phase that ran out adds no turn of its own');
 G.giveClue(g,'时间',1);G.guess(g,g.tiles.findIndex(t=>t.type==='assassin'));
 const over=JSON.stringify(g);assert.equal(G.timeout(g),false);assert.equal(JSON.stringify(g),over);
});
test('deal keeps seasons of one show apart and still fills the board',()=>{
 const titles=['进击的巨人','进击的巨人 第二季','进击的巨人 最终季','剧场版 鬼灭之刃 无限列车篇','鬼灭之刃','Re：从零开始的异世界生活','Re：从零开始的异世界生活 第二季'];
 const pool=[...titles.map((name_cn,id)=>({id,name_cn})),...Array.from({length:40},(_,i)=>({id:100+i,name_cn:String.fromCharCode(0x4e00+i*7)+'番'}))];
 for(let n=0;n<50;n++){
  const keys=G.deal(pool).map(a=>a.name_cn);
  assert.equal(new Set(keys).size,25);
  assert.ok(keys.filter(k=>k.includes('进击的巨人')).length<=1);
  assert.ok(keys.filter(k=>k.includes('鬼灭之刃')).length<=1);
  assert.ok(keys.filter(k=>k.startsWith('Re：')).length<=1);
 }
 // A pool of one franchise cannot avoid repeats, so the rest are dealt anyway.
 const same=Array.from({length:25},(_,id)=>({id,name_cn:'进击的巨人 '+id}));
 assert.equal(new Set(G.deal(same).map(a=>a.id)).size,25);
});
test('deal counts Latin words as one unit, needs more than a generic opening, and matches stripped titles',()=>{
 const pairs=[['DARKER THAN BLACK -黑之契约者-','DARLING in the FRANXX'],['Re：从零开始的异世界生活','Re：创世主们'],['异世界舅舅','异世界药局'],['关于我转生变成史莱姆这档事','关于我女友是个一本正经的碧池这件事'],['只有我不存在的城市','只有我进入的隐藏地下城'],['魔法少女小圆','魔法少女奈叶']];
 const kept=["银魂'",'异世界魔王与召唤少女的奴隶魔术Ω','魔法少女奈叶A\'s'];
 const filler=Array.from({length:30},(_,i)=>({id:100+i,name_cn:String.fromCharCode(0x4e00+i*7)+'番'}));
 // Both titles of each pair can share a board.
 for(const [a,b] of pairs){const pool=[{id:1,name_cn:a},{id:2,name_cn:b},...filler];
  const ids=G.deal(pool,()=>0.999).map(x=>x.id);assert.ok(ids.includes(1)&&ids.includes(2),a+' / '+b);}
 // A longer shared opening still counts as one franchise.
 for(const [a,b] of [[kept[0],'银魂'],['黑执事Ⅱ','黑执事'],['侵略!?乌贼娘','侵略!乌贼娘'],['続・終物語','終物語'],[kept[1],'异世界魔王与召唤少女的奴隶魔术'],[kept[2],'魔法少女奈叶']]){
  const pool=[{id:1,name_cn:a},{id:2,name_cn:b},...filler];
  for(let n=0;n<20;n++){const ids=G.deal(pool).map(x=>x.id);assert.ok(!(ids.includes(1)&&ids.includes(2)),a+' / '+b);}
 }
});
test('awards judge every ballot by the card colour, banned or not, and only majority rooms get the player awards',()=>{
 const make=voting=>{
  const g=G.create(pool,()=>0.3,'red',{ban:true,banMode:'round'});
  g.voting=voting;g.lineup=[{id:'rc',name:'红队长',team:'red',role:'captain'},{id:'a',name:'甲',team:'red',role:'guesser'},{id:'b',name:'乙',team:'red',role:'guesser'},{id:'c',name:'丙',team:'red',role:'guesser'},{id:'bc',name:'蓝队长',team:'blue',role:'captain'},{id:'d',name:'丁',team:'blue',role:'guesser'}];
  return g;
 };
 const g=make('majorityAll'),of=type=>g.tiles.flatMap((t,i)=>t.type===type?[i]:[]);
 const reds=of('red'),blues=of('blue'),[neutral]=of('neutral'),[assassin]=of('assassin');
 const flip=(index,ballot)=>{const t=g.turns[g.turns.length-1];G.guess(g,index);(t.ballots??=[]).push(ballot);};
 // Red bans nothing and finds two before a neutral. 乙 backs the other team's card, then the assassin.
 G.giveClue(g,'一',2);
 flip(reds[0],{a:reds[0],b:blues[0],c:reds[0]});
 flip(reds[1],{a:reds[1],b:assassin,c:'end'});
 // Blue's captain bans a red card; red turns it over in the next round anyway, which ends the turn.
 G.stop(g);G.ban(g,reds[2]);G.giveClue(g,'二',1);flip(blues[1],{d:blues[1]});G.stop(g);
 G.giveClue(g,'三',3);flip(reds[3],{a:reds[3],b:reds[3],c:reds[3]});
 assert.equal(g.banned.blue,reds[2]);flip(reds[2],{a:reds[2],b:neutral,c:reds[2]});
 assert.equal(g.tiles[reds[2]].bannedBy,'blue');assert.equal(g.turn,'blue','a banned card ends the round');
 g.winner='red';const result=G.awards(g);
 // 三 also found two, so the earlier 一 keeps it.
 assert.deepEqual(result.clue,{team:'red',round:1,word:'一',count:2,hits:2,misses:0,captain:'红队长'});
 // MVP comes from the winners and 第六人 from the losers: blue's 丁 found one of their own and missed nothing.
 assert.deepEqual(result.mvp.map(s=>[s.name,s.hits,s.score]),[['甲',4,0]]);
 assert.deepEqual(result.sixth,[]);
 const lost=G.awards({...g,winner:'blue'});
 assert.deepEqual(lost.mvp.map(s=>[s.name,s.hits]),[['丁',1]]);
 assert.deepEqual(lost.sixth.map(({name,hits,score,neutral,opponent,assassin})=>({name,hits,score,neutral,opponent,assassin})),[{name:'乙',hits:1,score:2+100+1,neutral:1,opponent:1,assassin:1}]);
 for(const voting of ['unanimous','any',undefined]){const h={...g,voting};assert.deepEqual([G.awards(h).mvp,G.awards(h).sixth],[[],[]]);assert.equal(G.awards(h).clue.word,'一');}
 assert.equal(G.awards({...g,voting:'majority'}).mvp.length,1);
});
test('awards share ties and skip a zero',()=>{
 const g=G.create(pool,()=>0.3,'red');g.voting='majority';g.winner='red';
 g.lineup=[{id:'a',name:'甲',team:'red',role:'guesser'},{id:'b',name:'乙',team:'red',role:'guesser'},{id:'c',name:'丙',team:'blue',role:'guesser'},{id:'d',name:'丁',team:'blue',role:'guesser'}];
 const reds=g.tiles.flatMap((t,i)=>t.type==='red'?[i]:[]);
 const blues=g.tiles.flatMap((t,i)=>t.type==='blue'?[i]:[]),[neutral]=g.tiles.flatMap((t,i)=>t.type==='neutral'?[i]:[]);
 G.giveClue(g,'词',null);G.guess(g,reds[0]);g.turns[0].ballots=[{a:reds[0],b:reds[1]}];
 // Blue's 丙 and 丁 both score 2, but one from a red card and one from two neutrals: the red card is the worse miss.
 G.stop(g);G.giveClue(g,'词',null);G.guess(g,blues[0]);g.turns[1].ballots=[{c:reds[2],d:neutral}];
 G.guess(g,blues[1]);g.turns[1].ballots.push({c:'end',d:neutral});
 const result=G.awards(g);
 assert.deepEqual(result.mvp.map(s=>s.name).sort(),['乙','甲']);
 assert.deepEqual(result.sixth.map(s=>[s.name,s.score,s.opponent,s.neutral]),[['丙',2,1,0]]);
 assert.deepEqual(G.awards({...g,winner:'blue'}).sixth,[],'the red guessers missed nothing');
 assert.equal(result.clue.count,null);
 // A turn the clock ran out on has no word, and a game with nothing found has no 最佳提示.
 assert.equal(G.awards(G.create(pool)).clue,null);
});
