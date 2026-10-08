const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startWorker}=require('./worker-server.cjs');
// A short grace period and a 3-second turn option keep presence and timer paths
// quick; the pinned random makes blue start and fixes the map's layout.
const GRACE=6000;
(async()=>{
 const worker=await startWorker({GRACE_MS:GRACE,TEST_TURN_SECONDS:3,TEST_RANDOM:0.8});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const base=worker.base;
  const init=()=>{
   window.presentationEvents=[];
   // Every synthesized voice is recorded so sound cannot quietly come back.
   window.audioEvents=[];
   const Sound=window.AudioContext||window.webkitAudioContext;
   if(Sound){
    const {createOscillator,createBufferSource}=Sound.prototype;
    Sound.prototype.createOscillator=function(){window.audioEvents.push('tone');return createOscillator.call(this);};
    Sound.prototype.createBufferSource=function(){window.audioEvents.push('noise');return createBufferSource.call(this);};
   }
   document.addEventListener('animationstart',event=>{if(event.animationName==='card-flip')window.presentationEvents.push({type:'flip-start',index:event.target.dataset.index,front:!!event.target.querySelector('.reveal-front')});});
   document.addEventListener('animationend',event=>{if(event.animationName==='card-flip')window.presentationEvents.push({type:'flip-end',index:event.target.dataset.index});});
   new MutationObserver(records=>{
    for(const {target,attributeName,addedNodes,removedNodes} of records){
     for(const node of addedNodes)if(node.classList?.contains('reveal-front'))window.presentationEvents.push({type:'front-added',index:target.dataset.index});
     for(const node of removedNodes)if(node.classList?.contains('reveal-front'))window.presentationEvents.push({type:'front-removed',index:target.dataset.index});
     if(target.id==='phaseTransition'&&attributeName==='hidden'&&!target.hidden)window.presentationEvents.push({type:'phase',text:target.textContent});
     if(target.id==='resultDialog'&&attributeName==='open'&&target.open)window.presentationEvents.push({type:'result'});
    }
   }).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','open']});
  };
  // One browser context per player: tabs of one browser share a seat. Every room
  // socket runs through a proxy, so a test can cut one player's network.
  const pages=[],networks=[],errors=[];
  for(let i=0;i<5;i++){
   const context=await browser.newContext({viewport:{width:1440,height:1100}});
   await context.addInitScript(init);
   await context.route(/https:\/\//,route=>route.abort());
   const network={down:false};networks.push(network);
   await context.routeWebSocket(/\/api\/room\/\d{6}\/ws$/,ws=>{
    if(network.down){ws.close({code:1011,reason:'offline'});return;}
    const server=ws.connectToServer();
    ws.onMessage(message=>{if(!network.down)server.send(message);});
    server.onMessage(message=>{if(!network.down)ws.send(message);});
   });
   const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));pages.push(p);
   await p.goto(base);await p.fill('#playerName','测试玩家'+(i+1));
   if(i===0)await p.click('#createRoom');
   else{await p.fill('#roomCodeInput',await pages[0].locator('#roomCode').innerText());await p.click('#joinRoomForm button');}
   await expect(p.locator('#roomPanel')).toBeVisible();
  }
  const seats=['red-captain','red-guesser','blue-captain','blue-guesser','blue-guesser'];
  const code=await pages[0].locator('#roomCode').innerText();
  await expect(pages[0].locator('#unseat, .lobby-first-turn')).toHaveCount(0);
  await expect(pages[0].locator('#copyCode')).toHaveText('');
  // The address bar carries the room link while the code is shown.
  for(const p of pages)await expect(p).toHaveURL(`${base}/${code}`);
  await pages[0].click('#toggleCode');
  for(const p of pages)await expect(p.locator('#roomCode')).toHaveText('••••••');
  for(const p of pages)await expect(p).toHaveURL(`${base}/`);
  await expect(pages[0].locator('#toggleCode')).toHaveAttribute('aria-label','显示房间号');
  await pages[1].click('#toggleCode');await expect(pages[1].locator('#roomCode')).toHaveText(code);
  await pages[1].reload();await expect(pages[1].locator('#roomCode')).toHaveText(code);
  await pages[2].reload();await expect(pages[2].locator('#roomCode')).toHaveText('••••••');
  // Stub only the clipboard boundary to verify the copied value and transient feedback.
  await pages[0].evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedRoomCode=text;}}}));
  await pages[0].click('#copyCode');
  await expect(pages[0].locator('#copyCode')).toHaveAttribute('aria-label','已复制房间号');
  assert.equal(await pages[0].evaluate(()=>window.copiedRoomCode),code);
  await expect(pages[0].locator('#roomCode')).toHaveText('••••••');
  await expect(pages[0].locator('#copyCode')).toHaveAttribute('aria-label','复制房间号');
  await pages[0].evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Denied');}}}));
  await pages[0].click('#copyCode');await expect(pages[0].locator('#roomNotice')).toContainText('复制失败');
  await expect(pages[0].locator('#roomNotice')).not.toContainText(code);
  await pages[0].evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedRoomLink=text;}}}));
  await pages[0].click('#copyLink');
  await expect(pages[0].locator('#copyLink')).toHaveAttribute('aria-label','已复制房间链接');
  await expect(pages[0].locator('#copyCode')).toHaveAttribute('aria-label','复制房间号');
  assert.equal(await pages[0].evaluate(()=>window.copiedRoomLink),`${base}/${code}`);
  await expect(pages[0].locator('#copyLink')).toHaveAttribute('aria-label','复制房间链接');
  await pages[0].click('#toggleCode');
  for(const p of pages)await expect(p.locator('#roomCode')).toHaveText(code);
  await pages[1].reload();await expect(pages[1]).toHaveURL(`${base}/${code}`);await expect(pages[1].locator('#roomCode')).toHaveText(code);
  // Another room's link shows its entry without dropping this browser's seat; the root link still resumes it.
  {
   const other=code==='100000'?'100001':'100000';
   await pages[1].goto(`${base}/${other}`);await expect(pages[1].locator('#roomCodeInput')).toHaveValue(other);await expect(pages[1].locator('#roomPanel')).toBeHidden();
   await pages[1].goto(base);await expect(pages[1].locator('#roomCode')).toHaveText(code);await expect(pages[1]).toHaveURL(`${base}/${code}`);
  }
  await expect(pages[0].locator('#unseatedPlayers .player-row')).toHaveCount(5);
  await expect(pages[0].locator('#unseatedLabel')).toHaveText('观战席');
  await expect(pages[0].locator('#readyCount')).toHaveText('0 / 0 人已准备');
  await expect(pages[0].locator('#startBlockers')).toHaveText('你在观战席，选择队伍和位置即可加入游戏');
  for(let i=0;i<5;i++)await pages[i].click(`[data-seat="${seats[i]}"]`);
  await expect(pages[0].locator('#roomTeams .player-row')).toHaveCount(5);
  await expect(pages[0].locator('#unseatedSection')).toBeHidden();
  for(const i of [0,1]){
   const seat=pages[i].locator(`[data-seat="${seats[i]}"]`);
   await expect(seat).toHaveText('离座');await expect(seat).toBeEnabled();
   await seat.click();await expect(pages[i].locator('#unseatedPlayers .is-me')).toBeVisible();
   await expect(pages[i].locator('#readyButton')).toBeDisabled();
   await seat.click();await expect(seat).toHaveText('离座');
  }
  await expect(pages[0].locator('#unseatedSection')).toBeHidden();
  await expect(pages[0].locator('#roomTeams .is-me .host-mark')).toHaveAttribute('aria-label','房主');
  await expect(pages[0].locator('#roomTeams .is-me')).not.toContainText('你');
  await expect(pages[0].locator('.header h1')).toHaveText('动画代号');
  await expect(pages[0].locator('.header .subtitle')).toHaveText('Anime Code · 比对方更快找到所有动画！');
  await expect(pages[0].locator('#readyButton')).toHaveText('准备');
  await expect(pages[0].locator('#roomCode')).toHaveText(/^\d{6}$/);
  await expect(pages[0].locator('#roomPanel')).not.toContainText('当前房间');
  await expect(pages[0].locator('#roomPanel')).not.toContainText('调整牌池保留准备状态');
  // Non-hosts can open the pool and rules to read them, but every control is locked.
  await expect(pages[1].locator('#roomFilters')).toHaveText('查看牌池 ↗');
  await expect(pages[1].locator('#roomRules')).toHaveText('查看规则 ↗');
  await expect(pages[0].locator('#roomFilters')).toHaveText('调整牌池 ↗');
  await expect(pages[1].locator('#roomPanel')).not.toContainText('由房主设置');
  await pages[1].click('#roomFilters');
  await expect(pages[1].locator('#filterTitle')).toHaveText('查看牌池');
  await expect(pages[1].locator('#minVotes')).toBeDisabled();await expect(pages[1].locator('#minVotesRange')).toBeDisabled();
  await expect(pages[1].locator('#applyFilters')).toBeHidden();await expect(pages[1].locator('#excludeTagInput')).toBeHidden();
  await pages[1].click('#filterForm [data-close]');await expect(pages[1].locator('#filterDialog')).not.toBeVisible();
  // Anyone can read the rules of the room they are about to play in; only the host moves them.
  await expect(pages[1].locator('#roomRules')).toBeVisible();
  await expect(pages[1].locator('#votingRule')).toBeDisabled();
  await expect(pages[1].locator('#rulesSummary')).toHaveText('全员一致 · 每轮最多提示数 + 1 张 · 可不填张数');
  await expect(pages[1].locator('#startRoom')).toBeHidden();
  await pages[0].click('#roomFilters');await pages[0].fill('#minVotes','999999');await expect(pages[0].locator('#applyFilters')).toBeDisabled();await pages[0].click('#filterDialog [data-close]');
  fs.mkdirSync('artifacts',{recursive:true});await pages[0].screenshot({path:'artifacts/multiplayer-lobby.png',fullPage:true});
  for(const width of [390,320]){
   await pages[0].setViewportSize({width,height:844});
   assert.equal(await pages[0].evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.ok(await pages[0].evaluate(()=>document.querySelector('.ready-row').getBoundingClientRect().top>=document.querySelector('.room-settings').getBoundingClientRect().bottom));
   await pages[0].screenshot({path:`artifacts/multiplayer-lobby-${width}.png`,fullPage:true});
  }
  await pages[0].setViewportSize({width:1440,height:1100});
  await pages[0].click('#readyButton');await expect(pages[0].locator('#readyCount')).toHaveText('1 / 5 人已准备');
  await pages[0].click('#roomRules');
  await expect(pages[0].locator('#rulesDialog')).toBeVisible();
  await pages[0].selectOption('#votingRule','unanimous');
  // Editing a room rule must not undo anyone's readiness.
  for(const p of pages)await expect(p.locator('#readyCount')).toHaveText('1 / 5 人已准备');
  await pages[0].selectOption('#votingRule','majority');
  await expect(pages[0].locator('#votingRule')).toHaveValue('majority');
  // One rule at a time: a second edit is dropped while the first is still in flight.
  // The ban count follows the ban switch and defaults to one per game.
  await expect(pages[0].locator('#banModeRule')).toHaveValue('game');
  await expect(pages[0].locator('#banModeRule')).toBeDisabled();
  await pages[0].check('#banRule');
  await expect(pages[0].locator('#rulesSummary')).toContainText('队长禁牌每局一次');
  await expect(pages[0].locator('#banModeRule')).toBeEnabled();
  await pages[0].locator('#rulesDialog .rule-list').screenshot({path:'artifacts/rules-ban-mode.png'});
  await pages[0].selectOption('#maxFlipsRule','unlimited');
  await pages[0].click('#rulesDialog [data-close]');
  await expect(pages[0].locator('#rulesDialog')).not.toBeVisible();
  // The summary is the lobby's one-line record of what was just changed, for everyone.
  for(const p of pages)await expect(p.locator('#rulesSummary')).toHaveText('过半同意 · 每轮翻牌不限 · 可不填张数 · 队长禁牌每局一次');
  await pages[0].click('#roomRules');await pages[0].selectOption('#maxFlipsRule','clue');
  await pages[0].click('#rulesDialog [data-close]');
  for(const p of pages)await expect(p.locator('#rulesSummary')).toHaveText('过半同意 · 每轮最多提示数 + 1 张 · 可不填张数 · 队长禁牌每局一次');
  for(const p of pages.slice(1)){await expect(p.locator('#roomTeams .player-row')).toHaveCount(5);await p.click('#readyButton');}
  for(const p of pages)await expect(p.locator('#readyButton')).toHaveText('取消准备');
  await expect(pages[0].locator('#startBlockers')).toHaveText('全员就绪，随时开局');
  await expect(pages[1].locator('#startBlockers')).toHaveText('全员就绪，等待房主开局');
  await pages[0].click('#roomFilters');await pages[0].fill('#minVotes','600');await pages[0].click('#applyFilters');
  await expect(pages[0].locator('#filterDialog')).not.toBeVisible();
  for(const p of pages)await expect(p.locator('#readyButton')).toHaveText('取消准备');
  // Chat: the lobby has one public channel, so it shows no tabs.
  const chatText=p=>p.locator('#chatList .chat-text');
  const say=async(p,channel,text)=>{await p.click(`#chatTabs [data-channel="${channel}"]`);await p.fill('#chatInput',text);await p.press('#chatInput','Enter');await expect(p.locator('#chatInput')).toHaveValue('');};
  for(const p of pages){await expect(p.locator('#chatPanel')).toBeVisible();await expect(p.locator('#chatTabs')).toBeHidden();}
  await pages[1].fill('#chatInput','  大厅   你好 ');await pages[1].click('#chatForm button');
  for(const p of pages)await expect(chatText(p)).toHaveText(['大厅 你好']);
  await expect(pages[0].locator('#chatList .chat-name')).toHaveText(['测试玩家2']);
  // The tab keeps what it heard across a reload.
  await pages[4].reload();await expect(chatText(pages[4])).toHaveText(['大厅 你好']);
  await expect(pages[4].locator('#readyButton')).toHaveText('取消准备');
  // A room starts private; once the host opens it, a stranger finds it in the public list.
  const stranger=await (async()=>{
   const context=await browser.newContext({viewport:{width:1440,height:1100}});
   await context.route(/https:\/\//,route=>route.abort());
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);return page;
  })();
  // Rooms report to the list in the background, so wait for the list itself before reading the dialog.
  const listedAs=playing=>expect.poll(()=>stranger.evaluate(()=>fetch('/api/rooms').then(r=>r.json())).then(v=>v.rooms.map(r=>r.playing))).toEqual(playing===null?[]:[playing]);
  for(const p of pages)await expect(p.locator('#publicRoom')).not.toBeChecked();
  await expect(pages[1].locator('#publicRoom')).toBeDisabled();
  await stranger.click('#browseRooms');
  await expect(stranger.locator('#roomsStatus')).toContainText('暂时没有公开房间');
  await pages[0].check('#publicRoom');
  for(const p of pages)await expect(p.locator('#publicRoom')).toBeChecked();
  await expect(pages[1].locator('#publicRoomHint')).toHaveText('已在公开房间列表中展示');
  await listedAs(false);await stranger.click('#refreshRooms');
  const listed=stranger.locator('#roomsList .rooms-row');
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText('测试玩家1的房间');await expect(listed).toContainText(code);
  await expect(listed.locator('.rooms-phase')).toHaveCount(0);await expect(listed.locator('small')).toHaveText(`房间内 ${pages.length} 人`);await expect(listed.locator('button')).toHaveText('加入');
  await stranger.locator('#roomsDialog').screenshot({path:'artifacts/public-rooms.png'});
  await expect(pages[0].locator('#startRoom')).toBeEnabled();await pages[0].click('#startRoom');
  for(const p of pages)await expect(p.locator('#board .card')).toHaveCount(25);
  // A room mid-match is marked, and newcomers can only watch it.
  await listedAs(true);await stranger.click('#refreshRooms');
  await expect(listed.locator('.rooms-phase')).toHaveText('游戏中');await expect(listed.locator('button')).toHaveText('观战');
  // Without a nickname the button sends the stranger back to fill one in, with the code ready.
  await listed.locator('button').click();
  await expect(stranger.locator('#roomsDialog')).not.toHaveAttribute('open','');
  await expect(stranger.locator('#roomCodeInput')).toHaveValue(code);await expect(stranger.locator('#entryNotice')).toContainText('昵称');
  await stranger.context().close();
  assert.ok(await pages[0].evaluate(()=>document.querySelector('#roomPanel').getBoundingClientRect().top>=document.querySelector('.game-layout').getBoundingClientRect().bottom));
  // Guesser and captain boards both fit a small laptop screen without scrolling.
  for(const p of [pages[1],pages[2]]){
   await p.setViewportSize({width:1366,height:768});
   await expect.poll(()=>p.evaluate(()=>document.querySelector('#board').lastElementChild.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
   await p.setViewportSize({width:1440,height:1100});
  }
  for(const p of pages){await expect(p.locator('#detailPanel')).toBeHidden();await expect(p.locator('#phaseText')).toBeHidden();}
  for(const p of pages)await expect.poll(()=>p.evaluate(()=>presentationEvents.some(e=>e.type==='phase'&&e.text.includes('蓝队先手')))).toBe(true);
  await expect(pages[1].locator('#board .card.known')).toHaveCount(0);await expect(pages[2].locator('#board .card.known')).toHaveCount(25);
  await expect(pages[3].locator('#captainView')).toBeDisabled();
  // Each role sees its own instructions, and only the acting role sees controls.
  for(const p of pages){await expect(p.locator('.view-tabs')).toBeHidden();await expect(p.locator('#guesserActions')).toBeHidden();}
  await expect(pages[2].locator('#roleBadge')).toHaveText('蓝队 · 队长');
  await expect(pages[2].locator('#turnTitle')).toHaveText('轮到你出题');
  await expect(pages[2].locator('#clueForm')).toBeVisible();await expect(pages[2].locator('#turnWaiting')).toBeHidden();
  await expect(pages[3].locator('#roleBadge')).toHaveText('蓝队 · 猜词人');
  await expect(pages[3].locator('#turnTitle')).toHaveText('蓝队队长出题中');
  await expect(pages[3].locator('#clueForm')).toBeHidden();await expect(pages[3].locator('#turnWaiting')).toBeVisible();
  for(const i of [0,1]){await expect(pages[i].locator('#turnTitle')).toHaveText('蓝队队长行动');await expect(pages[i].locator('#clueForm')).toBeHidden();}
  await expect(pages[2].locator('#numberInput')).toHaveAttribute('placeholder','不限');
  // The ban belongs to the captain still holding the clue, and it is public: the
  // guessers are the ones who decide whether that card is worth their round.
  await expect(pages[2].locator('#banCard')).toBeVisible();
  await expect(pages[2].locator('#banCard')).toHaveText('禁用⊘');
  await expect(pages[2].locator('#banCard')).toBeDisabled();
  for(const i of [0,1,3,4])await expect(pages[i].locator('#banCard')).toBeHidden();
  const banIndex=Number(await pages[2].locator('#board .card.neutral').first().getAttribute('data-index'));
  await pages[2].locator('#board .card').nth(banIndex).click();
  await pages[2].click('#banCard');
  // Both captains see the mark in the banning team's colour; the guessers do not.
  for(const i of [0,2]){
   const card=pages[i].locator('#board .card.is-banned');
   await expect(card).toHaveAttribute('data-index',String(banIndex));
   await expect(card).toHaveAttribute('data-ban-team','blue');
   await expect(card.locator('.cover .ban-mark')).toHaveText('⊘');
   await expect(card.locator('.card-name .ban-mark')).toHaveText('⊘');
  }
  for(const i of [1,3,4])await expect(pages[i].locator('#board .card.is-banned')).toHaveCount(0);
  await expect(pages[2].locator('#banCard')).toHaveText('取消禁用⊘');
  await pages[2].locator('.turn-panel').screenshot({path:'artifacts/turn-captain-ban.png'});
  await pages[2].locator('#board .card.is-banned').screenshot({path:'artifacts/card-banned.png'});
  await pages[2].click('#banCard');
  for(const p of pages)await expect(p.locator('#board .card.is-banned')).toHaveCount(0);
  // The card is still selected, so the button offers to ban it again.
  await expect(pages[2].locator('#banCard')).toHaveText('禁用⊘');
  await expect(pages[2].locator('#banCard')).toBeEnabled();
  await pages[3].emulateMedia({reducedMotion:'reduce'});
  assert.equal(await pages[3].locator('#turnWaiting i').first().evaluate(n=>getComputedStyle(n).animationName),'none');
  await pages[3].emulateMedia({reducedMotion:'no-preference'});
  await pages[2].locator('.turn-panel').screenshot({path:'artifacts/turn-active-captain.png'});
  await pages[3].locator('.turn-panel').screenshot({path:'artifacts/turn-waiting-guesser.png'});
  await expect(pages[0].locator('#blueRemaining')).toHaveText('9');await expect(pages[0].locator('#redRemaining')).toHaveText('8');
  // Chat in a match: captains share a channel, each team's guessers have their own.
  for(const p of pages)await expect(chatText(p)).toHaveText(['大厅 你好']);
  for(const i of [0,2])await expect(pages[i].locator('#chatTabs .chat-tab')).toHaveText(['公共','队长']);
  for(const i of [1,3,4])await expect(pages[i].locator('#chatTabs .chat-tab')).toHaveText(['公共','队内']);
  await say(pages[0],'captain','红队队长来了');
  await expect(pages[2].locator('#chatTabs [data-channel="captain"]')).toHaveClass(/has-unread/);
  await say(pages[2],'captain','收到');
  await expect(chatText(pages[0])).toHaveText(['红队队长来了','收到']);
  await say(pages[3],'blue','蓝队内部');
  await pages[4].click('#chatTabs [data-channel="blue"]');await expect(chatText(pages[4])).toHaveText(['蓝队内部']);
  await say(pages[1],'red','红队内部');
  await say(pages[2],'public','公共发言');
  await pages[1].click('#chatTabs [data-channel="public"]');await expect(pages[1].locator('#chatList .chat-role')).toHaveText(['队长']);
  // Nobody hears a channel they are not on.
  const heard=p=>p.evaluate(()=>JSON.parse(sessionStorage.getItem('anicode-chat')).messages.map(m=>m.text));
  assert.deepEqual(await heard(pages[0]),['大厅 你好','红队队长来了','收到','公共发言']);
  assert.deepEqual(await heard(pages[1]),['大厅 你好','红队内部','公共发言']);
  assert.deepEqual(await heard(pages[3]),['大厅 你好','蓝队内部','公共发言']);
  // The server refuses a channel the seat does not allow, whatever the page sends.
  const forged=await pages[1].evaluate(()=>new Promise(resolve=>{
   const ws=new WebSocket(`ws://${location.host}/api/room/${JSON.parse(localStorage.getItem('anicode-room')).code}/ws`);
   ws.onopen=()=>ws.send(JSON.stringify({type:'hello',token:JSON.parse(localStorage.getItem('anicode-room')).token}));
   ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='state')ws.send(JSON.stringify({type:'chat',id:'forged',channel:'captain',text:'偷看'}));if(m.type==='result'){ws.close();resolve(m);}};
  }));
  assert.equal(forged.ok,false);assert.match(forged.error,/频道/);
  assert.ok(!(await heard(pages[0])).includes('偷看'));
  await pages[3].locator('#chatPanel').screenshot({path:'artifacts/chat-guesser.png'});
  // A late joiner watches the match without a seat and switches between both maps.
  {
   const context=await browser.newContext({viewport:{width:1440,height:1100}});
   await context.route(/https:\/\//,route=>route.abort());
   const watcher=await context.newPage();watcher.on('pageerror',e=>errors.push(e.message));
   // A room link opens the entry with the code filled in.
   await watcher.goto(`${base}/${code}`);await expect(watcher.locator('#roomCodeInput')).toHaveValue(code);
   // The room takes the first join in, but its answer is lost on the way back.
   await context.route('**/api/enter',async route=>{await route.fetch();await route.abort();},{times:1});
   await watcher.fill('#playerName','观众');await watcher.click('#joinRoomForm button');
   await expect(watcher.locator('#entryNotice')).toContainText('请稍后重试');
   // The retry comes from the same browser, so it is the same member, not a second 观众.
   await watcher.click('#joinRoomForm button');
   await expect(watcher.locator('#board .card')).toHaveCount(25);
   await expect(pages[0].locator('#matchRoster .player-row')).toHaveCount(6);
   await expect(watcher.locator('#roleBadge')).toHaveText('观战中');
   await expect(watcher.locator('#myIdentity')).toContainText('观战中');
   await expect(watcher.locator('.view-tabs')).toBeVisible();
   await expect(watcher.locator('#captainView')).toHaveAttribute('aria-pressed','true');
   await expect(watcher.locator('#board .card.known')).toHaveCount(25);
   await watcher.click('#guesserView');
   await expect(watcher.locator('#guesserView')).toHaveAttribute('aria-pressed','true');
   await expect(watcher.locator('#board .card.known')).toHaveCount(0);
   for(const id of ['#clueForm','#guesserActions','#banCard'])await expect(watcher.locator(id)).toBeHidden();
   // A spectator only has the public channel.
   await expect(watcher.locator('#chatTabs')).toBeHidden();
   await say(pages[0],'captain','观众看不到');
   await watcher.fill('#chatInput','观众打招呼');await watcher.press('#chatInput','Enter');await expect(watcher.locator('#chatInput')).toHaveValue('');
   assert.ok(!(await heard(watcher)).includes('观众看不到'));
   await pages[3].click('#chatTabs [data-channel="public"]');await expect(chatText(pages[3])).toHaveText(['大厅 你好','公共发言','观众打招呼']);
   // Members sit in one group per team; the late joiner is in the spectators' group.
   await expect(pages[0].locator('#matchRosterList .roster-group.spectator')).toContainText('观众');
   await expect(pages[0].locator('#matchRosterList .roster-group.red .roster-role')).toHaveText('队长');
   await expect(pages[0].locator('#matchRosterSummary')).toHaveText('红队 2 · 蓝队 3 · 观战 1');
   await watcher.screenshot({path:'artifacts/multiplayer-spectator.png'});
   await watcher.click('#leaveRoom');await expect(watcher.locator('#roomEntry')).toBeVisible();
   await expect(pages[0].locator('#matchRoster .player-row')).toHaveCount(5);
   for(const p of pages)await expect(p.locator('#board .card')).toHaveCount(25);
   await context.close();
  }
  // Freeze the host renderer for longer than the grace period. The open socket
  // alone keeps the seat and the host, without any page JS running.
  const frozen=await pages[0].context().newCDPSession(pages[0]);
  await frozen.send('Page.setWebLifecycleState',{state:'frozen'});
  await pages[1].waitForTimeout(GRACE+2000);
  await expect(pages[1].locator('#matchRoster .player-row')).toHaveCount(5);
  await expect(pages[1].locator('#matchRoster .lobby-player-status.is-offline')).toHaveCount(0);
  await expect(pages[1].locator('#phaseText')).not.toContainText('断线');
  await frozen.send('Page.setWebLifecycleState',{state:'active'});await frozen.detach();
  await expect(pages[0].locator('#myIdentity .host-mark')).toBeVisible();
  assert.equal(await pages[1].locator('#matchRoster').innerText().then(t=>/在线|离线/.test(t)),false);
  for(const [word,count,reason] of [['','2','不能为空'],['two words','2','不能包含空格'],['时间','-1','不小于 0'],['时间','1.5','不小于 0']]){
   await pages[2].fill('#clueInput',word);await pages[2].fill('#numberInput',count);await pages[2].click('#clueForm button');
   await expect(pages[2].locator('#status')).toContainText(reason);await expect(pages[2].locator('#roomNotice')).toBeEmpty();
  }
  await pages[2].fill('#clueInput','时间');await pages[2].fill('#numberInput','2');
  // The network goes silent with the socket still open: the action gets no answer,
  // times out, and the client drops the socket and keeps retrying.
  networks[2].down=true;
  await pages[2].click('#clueForm button');
  await expect(pages[2].locator('#turnTitle')).toHaveText('正在重新连接',{timeout:16000});
  await expect(pages[2].locator('#status')).toContainText('请求超时');await expect(pages[2].locator('#clueForm button')).toBeDisabled();
  // Silence reads as a frozen page, so the strip states the retry is happening.
  await expect(pages[2].locator('#connectionStrip')).toBeVisible();
  await expect(pages[2].locator('#connectionStrip')).toContainText('连接中…');
  await expect(pages[2].locator('#connectionStrip')).toHaveAttribute('data-state','offline');
  await pages[2].screenshot({path:'artifacts/reconnect-strip.png'});
  // The dropped clue never reached the room.
  await expect(pages[3].locator('#clueWord')).not.toHaveText('时间');
  networks[2].down=false;
  await expect(pages[2].locator('#connectionStrip')).toHaveAttribute('data-state','online',{timeout:8000});
  await expect(pages[2].locator('#connectionStrip')).toBeHidden({timeout:5000});
  await expect(pages[2].locator('#clueForm button')).toBeEnabled();await expect(pages[2].locator('#status')).toBeEmpty();
  // A drop shorter than the grace period never shows on the other clients.
  await expect(pages[1].locator('#matchRoster .lobby-player-status.is-offline')).toHaveCount(0);
  await pages[2].click('#clueForm button');
  for(const p of pages)await expect(p.locator('#clueWord')).toHaveText('时间');
  await expect(pages[2].locator('#turnTitle')).toHaveText('蓝队猜词人行动');
  await expect(pages[2].locator('#banCard')).toBeHidden(); // the ban is locked once the clue is out
  // The flip budget is public, so every client can see how long the round can run.
  for(const p of pages)await expect(p.locator('#flipsLeft')).toHaveText('本轮还可翻 3 张');
  for(const i of [0,1,2]){
   await expect(pages[i].locator('#guesserActions')).toBeHidden();
  }
  // Two blue guessers under 过半同意 need both votes, so the tally is up before anyone votes.
  for(const p of pages){await expect(p.locator('#votePanel')).toBeVisible();await expect(p.locator('#voteRule')).toHaveText('过半同意 · 需 2 票');await expect(p.locator('#voteList')).toHaveText('还没有人投票');}
  for(const i of [3,4]){await expect(pages[i].locator('#turnTitle')).toHaveText('轮到你猜词');await expect(pages[i].locator('#guesserActions')).toBeVisible();await expect(pages[i].locator('#turnWaiting')).toBeHidden();}
  await pages[1].locator('.turn-panel').screenshot({path:'artifacts/turn-opponent.png'});
  await pages[3].locator('.turn-panel').screenshot({path:'artifacts/turn-active-guesser.png'});
  for(const p of pages)await expect.poll(()=>p.evaluate(()=>presentationEvents.some(e=>e.type==='phase'&&e.text.includes('蓝队猜词人行动')&&e.text.includes('「时间」 · 2')))).toBe(true);
  await pages[4].screenshot({path:'artifacts/multiplayer-transition.png',fullPage:true});
  const index=Number(await pages[2].locator('#board .card.blue').first().getAttribute('data-index'));
  await expect(pages[3].locator('#confirmGuess')).toHaveText('翻开');
  await expect(pages[3].locator('#endTurn')).toHaveText('结束回合');
  await pages[3].locator('#board .card').nth(index).click();
  await expect(pages[3].locator('#detailPanel')).toBeVisible();
  await expect(pages[3].locator('#confirmGuess')).toBeEnabled();
  await pages[3].click('#confirmGuess');
  for(const p of pages){await expect(p.locator('#votePanel')).toBeVisible();await expect(p.locator('#voteList')).toContainText('测试玩家4');}
  await expect(pages[4].locator('#board .card').nth(index).locator('.card-name .vote-avatars')).toHaveAttribute('title','1 票：测试玩家4');await expect(pages[3].locator('#board .card.revealed')).toHaveCount(0);
  await expect(pages[3].locator('#voteList .is-mine')).toContainText('测试玩家4（你）');await expect(pages[3].locator('#voteList .is-mine .vote-count')).toHaveText('1 / 2');
  await expect(pages[3].locator('#confirmGuess')).toHaveText('已投此牌');await expect(pages[3].locator('#confirmGuess')).toBeDisabled();
  // Only the voter can take a vote back, from their own row.
  await expect(pages[4].locator('#voteList .vote-withdraw')).toHaveCount(0);await expect(pages[4].locator('#voteList .vote-option')).not.toHaveClass(/is-mine/);
  // The voter's own vote is counted and shown on the card too.
  await expect(pages[3].locator('#board .card').nth(index).locator('.vote-avatar.own')).toHaveText('测');
  await expect(pages[3].locator('#board .card').nth(index).locator('.vote-avatars')).toHaveAttribute('title','1 票：测试玩家4（你）');
  await expect(pages[3].locator('#voteList .is-mine')).toHaveCount(1);
  // Deselecting a submitted card must keep the vote, without a second status message.
  await pages[3].locator('#board .card').nth(index).click();
  await expect(pages[3].locator('#detailPanel')).toBeHidden();
  await expect(pages[3].locator('.vote-avatar.own')).toHaveCount(1);
  const otherIndex=(index+1)%25;
  await pages[3].locator('#board .card').nth(otherIndex).click();
  await expect(pages[3].locator('#board .card.voted-by-me')).toHaveAttribute('data-index',String(index));
  await expect(pages[3].locator('#board .card.selected')).toHaveAttribute('data-index',String(otherIndex));
  await pages[3].click('#confirmGuess');
  await expect(pages[3].locator('#board .card.voted-by-me')).toHaveAttribute('data-index',String(otherIndex));
  await pages[3].click('#endTurn');await expect(pages[3].locator('#endTurn')).toHaveText('已投结束');
  await expect(pages[3].locator('#endTurn')).toBeDisabled();await expect(pages[3].locator('#voteList .is-mine')).toContainText('结束回合');
  await pages[3].click('#voteList .vote-withdraw');await expect(pages[3].locator('#status')).toContainText('已撤回投票');
  for(const p of pages)await expect(p.locator('#voteList')).toHaveText('还没有人投票');
  await expect(pages[3].locator('.vote-avatar.own')).toHaveCount(0);await expect(pages[3].locator('#voteList .vote-withdraw')).toHaveCount(0);
  await pages[3].locator('#board .card').nth(index).click();await pages[3].click('#confirmGuess');
  await expect(pages[3].locator('.vote-avatar.own')).toHaveCount(1);
  await pages[3].locator('.turn-panel').screenshot({path:'artifacts/step2-vote-feedback.png'});
  await expect(pages[1].locator('#voteList')).toContainText('测试玩家4');
  // Picking a row selects its card on the board, ready to follow the vote.
  await pages[4].click('#voteList .vote-target');
  await expect(pages[4].locator('#board .card.selected')).toHaveAttribute('data-index',String(index));await expect(pages[4].locator('#confirmGuess')).toHaveText('翻开');
  assert.equal(await pages[3].evaluate(()=>presentationEvents.filter(e=>e.type==='flip-start').length),0);
  for(const p of pages)await p.evaluate(()=>{window.audioEvents=[];});
  await pages[4].click('#confirmGuess');
  for(const p of pages)await expect(p.locator('#board .card.revealed')).toHaveCount(1);
  for(const p of pages)await expect(p.locator('#voteList')).toHaveText('还没有人投票');
  for(const p of pages){
   // Frozen/background renderers may coalesce CSS animation events. The front
   // lifecycle still must complete exactly once and release the update queue.
   await expect.poll(()=>p.evaluate(()=>presentationEvents.filter(e=>e.type==='front-removed').length)).toBe(1);
   assert.equal(await p.evaluate(()=>presentationEvents.filter(e=>e.type==='front-added').length),1);
   await expect(p.locator('.reveal-front')).toHaveCount(0);
   // The game has no sound at all, so a flip makes none.
   assert.deepEqual(await p.evaluate(()=>audioEvents),[]);
  }
  await expect(pages[3].locator('#blueRemaining')).toHaveText('8');
  for(const p of pages)await expect(p.locator('#flipsLeft')).toHaveText('本轮还可翻 2 张');
  await pages[3].reload();await expect(pages[3].locator('#board .card.revealed')).toHaveCount(1);await expect(pages[3].locator('#myIdentity')).toContainText('测试玩家4');
  await expect(pages[3].locator('#board .card.known')).toHaveCount(1);
  assert.deepEqual(await pages[3].evaluate(()=>presentationEvents),[]);
  // A second tab of the same browser is the same player, not a new seat, and
  // closing it leaves the first tab connected.
  const duplicatePromise=pages[3].context().waitForEvent('page');await pages[3].evaluate(()=>window.open('/','_blank'));const duplicate=await duplicatePromise;
  duplicate.on('pageerror',e=>errors.push(e.message));
  await expect(duplicate.locator('#board .card.revealed')).toHaveCount(1);
  await expect(duplicate.locator('#myIdentity')).toContainText('测试玩家4');
  await expect(duplicate.locator('#matchRoster .player-row')).toHaveCount(5);
  await duplicate.close();
  await pages[1].waitForTimeout(GRACE+1000);
  await expect(pages[1].locator('#matchRoster .lobby-player-status.is-offline')).toHaveCount(0);
  await pages[3].screenshot({path:'artifacts/multiplayer-game.png',fullPage:true});
  await pages[3].setViewportSize({width:390,height:844});
  assert.equal(await pages[3].evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.ok(await pages[3].evaluate(()=>document.querySelector('#roomPanel').getBoundingClientRect().top>=document.querySelector('.game-layout').getBoundingClientRect().bottom));
  await pages[3].screenshot({path:'artifacts/multiplayer-mobile.png',fullPage:true});
  // A voted stop announces the new turn; a neutral card must finish flipping before that announcement.
  for(const i of [3,4])await pages[i].click('#endTurn');
  for(const p of pages)await expect.poll(()=>p.evaluate(()=>presentationEvents.some(e=>e.type==='phase'&&e.text.includes('红队队长行动')&&e.text.includes('第 2 回合')))).toBe(true);
  await expect(pages[0].locator('#turnTitle')).toHaveText('轮到你出题');
  await expect(pages[1].locator('#turnTitle')).toHaveText('红队队长出题中');
  await expect(pages[3].locator('#turnTitle')).toHaveText('红队队长行动');await expect(pages[3].locator('#guesserActions')).toBeHidden();
  await expect(pages[4].locator('#phaseTransition')).toBeHidden({timeout:5000});
  await pages[1].bringToFront();
  await pages[0].fill('#clueInput','星空');await pages[0].fill('#numberInput','1');await pages[0].click('#clueForm button');
  await expect(pages[1].locator('#clueWord')).toHaveText('星空');
  await expect(pages[1].locator('#turnTitle')).toHaveText('轮到你猜词');await expect(pages[1].locator('#guesserActions')).toBeVisible();
  await expect(pages[1].locator('#votePanel')).toBeHidden();
  // The turn banner restates the turn panel heading and must never cover cards.
  await expect(pages[1].locator('#phaseTransition')).toBeVisible();await pages[1].evaluate(()=>clearTimeout(transitionTimer));
  const bannerClear=p=>p.evaluate(()=>{const a=document.querySelector('#phaseTransition').getBoundingClientRect(),b=document.querySelector('#board').getBoundingClientRect();return a.width>0&&(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom);});
  for(const [width,height] of [[1440,900],[390,844]]){await pages[1].setViewportSize({width,height});assert.ok(await bannerClear(pages[1]),`banner overlaps the board at ${width}px`);}
  await pages[1].setViewportSize({width:1440,height:1100});
  await pages[1].click('#phaseTransition button');await expect(pages[1].locator('#phaseTransition')).toBeHidden();
  const neutral=Number(await pages[0].locator('#board .card.neutral').first().getAttribute('data-index'));
  await pages[4].emulateMedia({reducedMotion:'reduce'});
  for(const p of pages)await p.evaluate(()=>{window.audioEvents=[];});
  await pages[1].locator('#board .card').nth(neutral).click();await pages[1].click('#confirmGuess');
  for(const p of pages)await expect.poll(()=>p.evaluate(()=>presentationEvents.some(e=>e.type==='phase'&&e.text.includes('蓝队队长行动')&&e.text.includes('第 3 回合')))).toBe(true);
  // A missed flip and the hand-over to the next captain stay silent on every client.
  for(const p of pages)assert.deepEqual(await p.evaluate(()=>audioEvents),[]);
  const ordering=await pages[1].evaluate(()=>presentationEvents);
  assert.ok(ordering.findIndex(e=>e.type==='front-removed'&&e.index===String(neutral))>=0);
  assert.ok(ordering.findIndex(e=>e.type==='front-removed'&&e.index===String(neutral))<ordering.findIndex(e=>e.type==='phase'&&e.text.includes('第 3 回合')));
  assert.equal(await pages[4].evaluate(()=>presentationEvents.filter(e=>e.type==='front-added').length),1);
  await pages[4].emulateMedia({reducedMotion:'no-preference'});
  await pages[2].fill('#clueInput','终点');await pages[2].fill('#numberInput','1');await pages[2].click('#clueForm button');
  for(const p of pages)await expect(p.locator('#clueWord')).toHaveText('终点');
  const assassin=Number(await pages[2].locator('#board .card.assassin').getAttribute('data-index'));
  for(const i of [3,4]){await pages[i].locator('#board .card').nth(assassin).click();await pages[i].click('#confirmGuess');}
  for(const p of pages)await expect(p.locator('#resultDialog')).toBeVisible();
  for(const p of pages){await expect(p.locator('#turnTitle')).toHaveText('红队获胜！');await expect(p.locator('#guesserActions')).toBeHidden();await expect(p.locator('#turnWaiting')).toBeHidden();}
  await expect(pages[3].locator('#roleBadge')).toHaveText('蓝队 · 猜词人');
  for(const p of pages){
   const events=await p.evaluate(()=>presentationEvents);
   assert.ok(events.findIndex(e=>e.type==='front-removed'&&e.index===String(assassin))>=0);
   assert.ok(events.findIndex(e=>e.type==='front-removed'&&e.index===String(assassin))<events.findIndex(e=>e.type==='result'));
  }
  await expect(pages[1].locator('#board .card.known')).toHaveCount(25);
  // Every player leaves the review on their own, from a sidebar button they can
  // see without reopening the dialog; the room waits for the last one.
  for(const p of pages){await expect(p.locator('#backToLobby')).toHaveText('返回大厅');await expect(p.locator('#againButton')).toHaveText('返回大厅');}
  await pages[0].click('#reviewButton');
  await expect(pages[0].locator('#resultDialog')).not.toBeVisible();
  await expect(pages[0].locator('#overActions')).toBeVisible();
  await pages[0].locator('.sidebar').screenshot({path:'artifacts/over-sidebar.png'});
  await pages[0].click('#backToLobby');
  await expect(pages[0].locator('#lobbyControls')).toBeVisible();
  await expect(pages[1].locator('#lobbyControls')).toBeHidden();
  await expect(pages[1].locator('#overActions')).toBeVisible();
  await expect(pages[0].locator('#startBlockers')).toContainText('看完地图返回大厅');
  await expect(pages[0].locator('#unseatedPlayers .lobby-player-status.is-reviewing')).toHaveCount(4);
  await pages[0].locator('#roomPanel').screenshot({path:'artifacts/lobby-reviewing.png'});
  for(const p of pages.slice(1))await p.click('#againButton');
  for(const p of pages)await expect(p.locator('#lobbyControls')).toBeVisible();
  await expect(pages[0].locator('#unseatedPlayers .is-reviewing')).toHaveCount(0);
  assert.ok(await pages[0].evaluate(()=>document.querySelector('.header').nextElementSibling.id==='roomPanel'));
  await pages[0].click('[data-seat="red-guesser"]');await pages[1].click('[data-seat="red-captain"]');
  for(const p of pages){await expect(p.locator('.room-team.red .seat-section').first()).toContainText('测试玩家2');await p.click('#readyButton');await expect(p.locator('#readyButton')).toHaveText('取消准备');}await expect(pages[0].locator('#startRoom')).toBeEnabled();await pages[0].click('#startRoom');
  await expect(pages[0].locator('#board .card.known')).toHaveCount(0);await expect(pages[1].locator('#board .card.known')).toHaveCount(25);
  await pages[0].close();
  // Within the grace period the player is not shown as gone.
  await pages[1].waitForTimeout(1500);
  await expect(pages[1].locator('#matchRoster .lobby-player-status.is-offline')).toHaveCount(0);
  await expect(pages[1].locator('#matchRoster .lobby-player-status.is-offline')).toHaveCount(1,{timeout:GRACE+5000});
  await expect(pages[1].locator('#phaseText')).not.toContainText('断线');
  await expect(pages[1].locator('#myIdentity .host-mark')).toBeVisible();
  // Only the host gets the member list.
  await expect(pages[1].locator('#manageMembers')).toBeVisible();
  await expect(pages[2].locator('#manageMembers')).toBeHidden();
  // A blank number is the "flip as many as you like" clue, and it lifts the budget.
  await pages[2].fill('#clueInput','继续');await pages[2].fill('#numberInput','');await pages[2].click('#clueForm button');
  await expect(pages[3].locator('#clueWord')).toHaveText('继续');
  await expect(pages[3].locator('#clueNumber')).toHaveText('不限');
  await expect(pages[3].locator('#flipsLeft')).toBeHidden();
  for(const i of [3,4])await pages[i].click('#endTurn');
  await expect(pages[1].locator('#turnTitle')).toHaveText('轮到你出题');
  await expect(pages[1].locator('#roleBadge')).toHaveText('红队 · 队长');
  // The host removes the away guesser from the member list; red has no guesser
  // left, so the confirmation warns that the match ends.
  await pages[1].click('#manageMembers');
  await expect(pages[1].locator('#membersList .rooms-row')).toHaveCount(4);
  {
   let asked='';pages[1].once('dialog',d=>{asked=d.message();d.accept();});
   await pages[1].click('#membersList [aria-label="移除 测试玩家1"]');
   await expect.poll(()=>asked).toContain('本局将结束');
  }
  await expect(pages[1].locator('#membersDialog')).toBeHidden();
  for(const p of pages.slice(1))await expect(p.locator('#lobbyControls')).toBeVisible();
  for(const p of pages.slice(1))await expect(p.locator('#roomTeams .player-row')).toHaveCount(4);
  // A lobby seat is not held: past the grace period the player has left, and
  // reopening the page offers the way back instead of resuming.
  {
   const context=pages[4].context();await pages[4].close();
   for(const p of pages.slice(1,4))await expect(p.locator('#roomTeams .player-row')).toHaveCount(3,{timeout:GRACE+5000});
   const back=await context.newPage();back.on('pageerror',e=>errors.push(e.message));await back.goto(base);
   await expect(back.locator('#rejoinDialog')).toBeVisible();await expect(back.locator('#rejoinRoom')).toHaveText('重新加入');
   await expect(back.locator('#roomPanel')).toBeHidden();
   await back.click('#rejoinRoom');
   await expect(back.locator('#unseatedPlayers')).toContainText('测试玩家5');
   await expect(pages[1].locator('#unseatedPlayers .player-row')).toHaveCount(1);
   pages[4]=back;
   // The player the host removed is told so, with no offer to come back.
   const removed=await pages[0].context().newPage();removed.on('pageerror',e=>errors.push(e.message));await removed.goto(base);
   await expect(removed.locator('#entryNotice')).toHaveText('你已被房主移出房间');
   await expect(removed.locator('#rejoinDialog')).toBeHidden();
   await removed.close();
  }
  // The turn timer: the test Worker accepts a 3-second limit the menu does not offer.
  const host=pages[1];
  await host.click('#roomRules');
  await host.evaluate(()=>document.getElementById('turnSecondsRule').add(new Option('3 秒','3')));
  await host.selectOption('#turnSecondsRule','3');await host.click('#rulesDialog [data-close]');
  for(const p of pages.slice(1))await expect(p.locator('#rulesSummary')).toContainText('每阶段限时 3 秒');
  await pages[4].click('[data-seat="red-guesser"]');
  for(const p of pages.slice(1)){await p.click('#readyButton');await expect(p.locator('#readyButton')).toHaveText('取消准备');}
  await expect(host.locator('#startRoom')).toBeEnabled();await host.click('#startRoom');
  for(const p of pages.slice(1)){await expect(p.locator('#turnTimer')).toBeVisible();await expect(p.locator('#turnTimer')).toHaveClass(/is-urgent/);}
  await expect(pages[2].locator('#turnTitle')).toHaveText('轮到你出题');
  // Nobody acts: the clue phase runs out on the server and the turn passes to red.
  await expect(host.locator('#turnTitle')).toHaveText('轮到你出题',{timeout:8000});
  await expect(host.locator('#history')).toContainText('蓝队超时');
  await expect(host.locator('#turnTimer')).toBeVisible();
  assert.deepEqual(errors,[]);
  console.log('5 players: room flows, reveal animation on every client, no sound, phase announcements, animation-before-transition/result ordering, dismiss/auto-hide, reduced motion, refresh without replay, shared tabs, reconnect, grace before away, captain swap, removal and turn timeout passed.');
 }finally{await browser.close();await worker.stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
