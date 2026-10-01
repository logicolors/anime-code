'use strict';
// HTTP mode uses the authoritative room server; ?local and file:// retain same-screen play.
if (location.protocol !== 'file:' && !new URLSearchParams(location.search).has('local')) {
  let room = null, connected = false, session = null, queue = Promise.resolve(), stopped = false, lastSnapshot = '', revealing = false;
  let presenceSocket=null,presenceRetry=null,pollTimer=null,polling=false,refreshSoon=false;
  // The presence socket doubles as a change signal: the server nudges every
  // member when the room moves, so a snapshot is fetched right away and the
  // timer below only covers a blocked, dropped or throttled socket. While
  // offline it retries faster, since reconnecting is the only thing being waited on.
  const idleDelay=()=>connected?3000:1000;
  let pendingAction=null;
  // What the single ban button would do on the next click: an index to ban, or
  // null to lift the ban already in place.
  let banTarget=null;
  let copyTimer=null;
  const roomIcons={
    copy:'<rect x="9" y="9" width="11" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff:'<path d="m3 3 18 18M10.6 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3 3.9M6.3 6.3A21 21 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.7-1.7M10 10a3 3 0 0 0 4 4"/>',
    crown:'<path d="M4 18.5h16M4.6 18.5 3 7.6l5.1 3.3L12 4.2l3.9 6.7L21 7.6l-1.6 10.9"/>'
  };
  const roomIcon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${roomIcons[name]}</svg>`;
  // The host is marked with a crown so the label does not read as part of a name.
  function hostMark() {
    const mark=el('span','host-mark');mark.innerHTML=roomIcon('crown');
    mark.title='房主';mark.setAttribute('role','img');mark.setAttribute('aria-label','房主');return mark;
  }
  const connectionNotices=new Set();
  // Silence reads as a frozen page. A strip states the connection is being
  // retried and, once it is back, confirms it briefly instead of just vanishing.
  let strip=null,stripTimer=null,wasConnected=true;
  function connectionStrip(state,text){
    if(!strip){
      strip=el('div','connection-strip');strip.id='connectionStrip';strip.hidden=true;
      strip.setAttribute('role','status');strip.setAttribute('aria-live','polite');
      strip.append(el('span','connection-strip-dot'),el('span','connection-strip-text'));
      document.body.append(strip);
    }
    clearTimeout(stripTimer);
    if(!state){strip.hidden=true;return;}
    strip.dataset.state=state;strip.querySelector('.connection-strip-text').textContent=text;strip.hidden=false;
    if(state==='online')stripTimer=setTimeout(()=>{strip.hidden=true;},2400);
  }
  function syncConnectionStrip(){
    if(!session)  {connectionStrip(null);wasConnected=true;return;}
    if(!connected){connectionStrip('offline','连接中… 正在重连，恢复后会自动同步');wasConnected=false;return;}
    if(!wasConnected){connectionStrip('online','已恢复连接');wasConnected=true;return;}
    connectionStrip(null);
  }
  try { session = JSON.parse(sessionStorage.getItem('anicode-room')); } catch {}
  document.body.classList.add('multiplayer');
  // The entry page is a hero over a board of covers; it takes the place of the page header.
  const entry = el('section','entry-hero'); entry.id = 'roomEntry';
  entry.innerHTML = `<div class="hero-inner"><p class="hero-eyebrow">ANIME CODE</p><h1 class="hero-title">动画代号</h1><p class="hero-tagline"><b class="red">红队</b> vs <b class="blue">蓝队</b>，<span>比对方更快找到所有动画！</span></p><div class="hero-create"><input id="playerName" maxlength="20" placeholder="你的昵称" aria-label="你的昵称" autocomplete="nickname"><button id="createRoom" class="button primary" type="button">创建房间</button></div><form id="joinRoomForm" class="hero-join"><span>有房间号？</span><input id="roomCodeInput" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="六位房间号" aria-label="六位房间号"><button class="text-button">加入 →</button></form><p class="hero-notice" id="entryNotice" role="status"></p><button class="hero-guide" id="guideButton" type="button"><span class="play" aria-hidden="true"></span>如何游玩</button></div>`;
  // The background sits on the page itself, so the lobby and the match open over
  // the same board instead of a fresh page.
  const backdrop = window.AniEntry?.mount(document.body);
  const lounge = el('section','panel room-panel'); lounge.id = 'roomPanel'; lounge.hidden = true;
  lounge.innerHTML = `
    <div class="room-top">
      <div><p class="room-eyebrow">ANIME CODE · 动画代号</p><div class="room-heading"><h2>房间 <span id="roomCode"></span></h2><button id="copyCode" class="room-icon-button" aria-label="复制房间号" title="复制房间号">${roomIcon('copy')}</button><button id="toggleCode" class="room-icon-button" aria-label="隐藏房间号" title="隐藏房间号" aria-pressed="false">${roomIcon('eye')}</button><span id="connectionState" role="status"></span></div><p id="myIdentity"></p></div>
      <div class="room-tools"><button id="leaveRoom" class="text-button">离开房间</button><button id="roomHelp" class="icon-button" type="button" aria-label="游戏规则">?</button></div>
    </div>
    <p id="roomNotice" class="room-notice" role="status" aria-live="polite"></p>
    <div id="lobbyControls">
      <div class="room-teams" id="roomTeams"></div>
      <aside class="room-settings" aria-label="房间设置">
        <div class="lobby-section-heading"><h3>本局设置</h3></div>
        <div class="lobby-pool"><span class="lobby-field-label">动画牌池</span><strong><span id="roomPoolCount"></span><small> 部</small></strong><div class="lobby-pool-bottom"><p id="settingsSummary"></p><button id="roomFilters" class="text-button">调整牌池 ↗</button></div></div>
        <div class="lobby-rules"><span class="lobby-field-label">规则设置</span><div class="lobby-rules-bottom"><p id="rulesSummary"></p><button id="roomRules" class="text-button" type="button">调整规则 ↗</button></div></div>
      </aside>
      <section class="unseated" id="unseatedSection" aria-label="待入座成员"><h3>待入座 <span id="unseatedCount"></span></h3><div id="unseatedPlayers"></div></section>
      <div class="ready-row">
        <div class="lobby-ready-state"><span class="lobby-ready-icon" aria-hidden="true">✓</span><div><strong id="readyCount"></strong><p id="startBlockers" role="status" aria-live="polite"></p></div></div>
        <div class="lobby-ready-actions"><button id="readyButton" class="button secondary">准备</button><button id="startRoom" class="button primary">开始游戏 →</button></div>
      </div>
    </div>
    <details id="matchRoster" class="match-roster" hidden><summary><span>房间成员</span><span id="matchRosterSummary"></span></summary><div id="matchRosterList"></div></details>`;
  document.querySelector('.header').after(entry,lounge);
  // The pool keeps its place in the lobby; the rules that only matter once play
  // starts move behind one button, where there is room to explain each of them.
  // Only the host edits the pool; everyone else opens the same dialog to read it.
  const includeEmptyText = $('includeTagsEmpty').textContent;
  function showRoomFilters() {
    const readOnly=!room||room.host!==room.me;
    showFilters();
    $('filterDialog').classList.toggle('is-readonly',readOnly);
    for(const node of $('filterForm').elements)if(node.id!=='applyFilters'&&!node.hasAttribute('data-close'))node.disabled=readOnly;
    const title=readOnly?'查看牌池':'调整牌池';
    $('filterTitle').textContent=title;$('filterDialog').querySelector('.panel-title [data-close]').setAttribute('aria-label','关闭'+title);
    $('filterForm').querySelector('[data-close]').textContent=readOnly?'关闭':'取消';
    $('applyFilters').hidden=readOnly;
    $('includeTagsEmpty').textContent=readOnly?'暂无包含标签':includeEmptyText;
  }
  const votingText = {unanimous:'全员一致',majority:'过半同意',any:'一票执行'};
  const rules = el('dialog'); rules.id = 'rulesDialog';
  rules.innerHTML = `<div class="dialog-body">
    <div class="panel-title"><h2 id="rulesTitle">规则设置</h2><button class="icon-button" data-close aria-label="关闭规则设置">×</button></div>
    <div class="rule-list">
      <div class="rule-row"><div><label for="votingRule">猜词人行动</label><p>复数猜词人时的行动规则</p></div><select id="votingRule"><option value="unanimous">全员一致</option><option value="majority">过半同意</option><option value="any">一票执行</option></select></div>
      <div class="rule-row"><div><label for="maxFlipsRule">最多翻牌数量</label><p>每轮能翻开的牌数上限</p></div><select id="maxFlipsRule"><option value="clue">提示数 + 1</option><option value="unlimited">不限</option></select></div>
      <label class="rule-row"><div><b>允许不填提示张数</b><p>队长可以只写提示词、张数留空。留空的这一轮不设翻牌上限，翻到非己方牌或主动结束为止。</p></div><input type="checkbox" id="freeCountRule"></label>
      <label class="rule-row"><div><b>队长禁牌</b><p>额外玩法：队长出题时可以禁掉一张牌，只有双方队长看得到。禁用一直持续到本队队长下一次出题，期间无论哪一队翻开它，无论对错当轮立刻结束，翻开的禁用牌会一直保留标志。</p></div><input type="checkbox" id="banRule"></label>
    </div>
    <div class="dialog-actions"><button class="button primary" data-close>完成</button></div>
  </div>`;
  document.body.append(rules);
  // app.js wires `[data-close]` once at load, before this dialog exists.
  for(const button of rules.querySelectorAll('[data-close]'))button.onclick=()=>rules.close();
  $('guideButton').onclick = () => window.AniDemo?.openGuide();
  // The lobby hides the page header, so it carries its own way to the rules.
  $('roomHelp').onclick = () => $('helpButton').click();
  function showEntry(visible) {
    entry.hidden=!visible;document.body.classList.toggle('on-entry',visible);
    if(visible){backdrop?.show();backdrop?.setMode('entry');backdrop?.setTeam(null);document.body.classList.remove('on-lobby');}
  }
  showEntry(true);
  // Banning uses the same card selection as guessing, so it sits with the clue
  // form the captain is already looking at.
  const banButton = el('button','button secondary'); banButton.id = 'banCard'; banButton.type = 'button'; banButton.hidden = true;
  $('clueForm').after(banButton);
  const votes = el('div','vote-panel'); votes.id = 'votePanel';
  votes.innerHTML = `<div id="voteList" role="status" aria-live="polite"></div><button id="cancelVote" class="text-button">撤票</button>`;
  $('guesserActions').after(votes);
  // After the match each player leaves the review on their own, so the way out
  // sits in the sidebar at the same weight as the 翻开 button it replaces —
  // the small link in the result dialog was easy to miss once that was closed.
  const over = el('div','over-actions'); over.id = 'overActions'; over.hidden = true;
  over.innerHTML = `<button class="button primary full" id="backToLobby">返回大厅</button><button class="button secondary full" id="reviewMap">查看完整地图</button>`;
  votes.after(over);
  const filterNotice=el('p','room-notice');filterNotice.id='filterNotice';filterNotice.setAttribute('role','status');
  $('poolCount').after(filterNotice);
  $('clueForm').noValidate=true;$('joinRoomForm').noValidate=true;
  for(const id of ['clueInput','numberInput'])$(id).setAttribute('aria-describedby','status');
  for(const id of ['playerName','roomCodeInput'])$(id).setAttribute('aria-describedby','entryNotice');
  // Online identity determines the map; view switching belongs to local play.
  document.querySelector('.view-tabs').hidden = true;
  const roleBadge = el('div','role-badge'); roleBadge.id = 'roleBadge';
  document.querySelector('.turn-panel .section-label').replaceWith(roleBadge);
  const turnHeading = el('div','turn-heading');
  $('turnTitle').before(turnHeading);
  const waiting = el('span','waiting-dots'); waiting.id = 'turnWaiting'; waiting.hidden = true;
  waiting.setAttribute('aria-hidden','true');
  waiting.append(el('i'),el('i'),el('i'));
  turnHeading.append($('turnTitle'),waiting);
  $('turnTitle').setAttribute('role','status');
  $('captainView').textContent = '◇ 我的队长地图';
  $('newButton').textContent = '↩ 返回大厅';
  $('againButton').textContent = '返回大厅';
  $('applyFilters').textContent = '保存房间牌池';
  $('clueForm').querySelector('button').textContent = '发布提示 →';
  document.querySelector('.table-note').hidden = true;
  $('helpDialog').querySelector('.dialog-body').innerHTML = `<h2>玩法说明</h2><ol class="help-list"><li><span>25 部动画里藏着<b class="tone red">红队</b>、<b class="tone blue">蓝队</b>、<b class="tone neutral">中立牌</b>和一张<b class="tone assassin">刺客</b>，队长知道每张牌的颜色。</span></li><li>队长每回合给出一个提示词和一个数字，比如「机器人 2」，意思是有 2 部本队动画和「机器人」有关。</li><li>猜词人按提示翻牌：翻到本队的可以接着猜，也可以随时结束回合；翻到中立或对方的牌，回合马上结束。</li><li>先翻出本队全部动画的一方获胜；翻到刺客，直接判负。</li></ol><p class="help-tip">先手队要找 9 部，后手队 8 部；默认每回合最多翻「提示数 + 1」张。</p><div class="dialog-actions"><button class="button secondary" id="helpGuide" type="button">▶ 如何游玩</button><button class="button primary" data-close>知道了</button></div>`;
  $('helpDialog').querySelector('[data-close]').onclick = () => $('helpDialog').close();
  $('helpGuide').onclick = openGuideFromHelp;
  $('newDialog').querySelector('h2').textContent = '中止本局并回大厅？';
  $('newDialog').querySelector('p').textContent = '返回大厅会清空本局进度。可以调整牌池、重新分队，开启下一局。';
  $('restartConfirm').textContent = '中止并全员返回';
  const areas = ['.scoreboard','.toolbar','.game-layout'];
  function showGame(visible) {
    for (const selector of areas) document.querySelector(selector).hidden=!visible;
    document.body.classList.toggle('in-match',visible);
    const anchor=document.querySelector(visible?'.game-layout':'.header');
    if(anchor.nextElementSibling!==lounge)anchor.after(lounge);
    if(!visible)document.title='动画代号 · Anime Code';
  }
  showGame(false);
  function notice(text) { (room ? $('roomNotice') : $('entryNotice')).textContent = text; }
  function operation(text) { if ($('status')) $('status').textContent = text || ''; }
  function actionUsesOperation(action) { return action === 'clue' || action === 'vote'; }
  function feedbackId(action) {return actionUsesOperation(action)?'status':action==='settings'&&$('filterDialog').open?'filterNotice':room?'roomNotice':'entryNotice';}
  function clearConnectionNotices(){for(const id of connectionNotices)$(id).textContent='';connectionNotices.clear();}
  function saveSession(value) {
    clearTimeout(copyTimer);setCopyFeedback(false);
    disconnectPresence();session=value;
    if(value){sessionStorage.setItem('anicode-room',JSON.stringify(value));connectPresence();if(!stopped){clearTimeout(pollTimer);pollTimer=setTimeout(poll,0);}}
    else {sessionStorage.removeItem('anicode-room');clearTimeout(pollTimer);pollTimer=null;}
  }
  function disconnectPresence(){clearTimeout(presenceRetry);const socket=presenceSocket;presenceSocket=null;socket?.close();}
  function connectPresence(){
    if(!session||stopped||presenceSocket)return;
    const identity=session,socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/presence`);presenceSocket=socket;
    socket.onopen=()=>{if(session===identity)socket.send(JSON.stringify(identity));else socket.close();};
    // The nudge carries no state: it only says the snapshot is stale, so the
    // authoritative fetch, permission trimming and ordering stay on one path.
    socket.onmessage=event=>{
      if(presenceSocket!==socket||session!==identity)return;
      try{if(JSON.parse(event.data).changed)poll();}catch{}
    };
    socket.onclose=()=>{if(presenceSocket!==socket)return;presenceSocket=null;if(session&&!stopped)presenceRetry=setTimeout(connectPresence,1500);};
    socket.onerror=()=>socket.close();
  }
  function enqueue(fn) { queue=queue.then(fn,fn); return queue; }
  async function api(route, payload) {
    let response,value;
    try {
      response = await fetch(route,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session.token}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(5000)});
      value = await response.json();
    } catch(error) {const failure=new Error('联机请求失败。');failure.name=error.name;failure.connectionFailure=true;throw failure;}
    if(response.status>=500){const error=new Error('联机服务暂时不可用。');error.connectionFailure=true;throw error;}
    if(!response.ok)throw new Error(value.error||'请求失败，请稍后重试。');return value;
  }
  function resetEntry() {hideTransition();saveSession(null);room=null;game=null;selected=null;lastSnapshot='';clearConnectionNotices();syncConnectionStrip();operation('');closeDialogs();showEntry(true);lounge.hidden=true;showGame(false);document.title='动画代号 · Anime Code';}
  function handleError(error, action='') {
    if (/不存在或已过期|身份已失效/.test(error.message)) {resetEntry();notice(error.message);return;}
    if (error.connectionFailure || ['TimeoutError','AbortError'].includes(error.name)) {
      connected=false;lastSnapshot='';
      const reason=error.name==='TimeoutError'?'请求超时':'连接暂时中断';
      const text=session?`${reason}，正在重连；恢复后会自动同步。${actionUsesOperation(action)?'本次操作结果待确认，请以同步后的状态为准。':''}`:`${reason}，请稍后重试创建或加入房间。`;
      const id=feedbackId(action);$(id).textContent=text;connectionNotices.add(id);
      syncConnectionStrip();
      if(room)renderRoom();
    } else $(feedbackId(action)).textContent=error.message;
  }
  function command(action, extra={}) {
    if(!connected||!session||pendingAction)return;
    if(action==='vote'&&((extra.choice===null&&!Object.hasOwn(room.votes,room.me))||room.votes[room.me]===extra.choice))return;
    // Capture the board version at click time so delayed requests cannot act on a new turn.
    const payload={action,...extra,code:session?.code,epoch:room?.epoch};
    const id=feedbackId(action);$(id).textContent=actionUsesOperation(action)?'正在提交…':'';
    pendingAction=action;
    if(game)renderOnlineActions();
    return enqueue(async()=>{
      try{
        const state=await api('/api/action',payload);if(state.left){resetEntry();return;}
        connected=true;clearConnectionNotices();syncConnectionStrip();$(id).textContent='';await accept(state);
        if(action==='settings'&&extra.filters)$('filterDialog').close();
        if(action==='vote'&&extra.choice===null&&state.epoch===payload.epoch)operation('已撤票');
      }catch(error){handleError(error,action);}
      finally{pendingAction=null;if(room)renderRoom();}
    });
  }
  async function enterRoom(action) {
    if($('createRoom').disabled)return;
    const name=$('playerName').value.trim();if(!name){notice('请先输入昵称。');$('playerName').focus();return;}
    if(name.length>20){notice('昵称最多 20 个字符。');$('playerName').focus();return;}
    if(action==='join'&&!/^\d{6}$/.test($('roomCodeInput').value.trim())){notice('请输入六位数字房间号。');$('roomCodeInput').focus();return;}
    $('createRoom').disabled=true;$('joinRoomForm').querySelector('button').disabled=true;
    await enqueue(async()=>{try{const value=await api('/api/enter',{action,name,code:$('roomCodeInput').value.trim()});saveSession({code:value.state.code,token:value.token});connected=true;wasConnected=true;syncConnectionStrip();notice('');await accept(value.state);}catch(error){handleError(error,'entry');}});
    $('createRoom').disabled=false;$('joinRoomForm').querySelector('button').disabled=false;
  }
  async function accept(state) {
    const serialized=JSON.stringify(state);if(serialized===lastSnapshot)return;lastSnapshot=serialized;
    const previous=room, oldGame=game;
    // Compare authoritative snapshots on every client, including players who did not cast the deciding vote.
    const sameBoard=oldGame&&state.game&&oldGame.tiles.every((t,i)=>t.anime.id===state.game.tiles[i]?.anime.id);
    // The acting team is the turn before the flip, so compare against that.
    const flips=sameBoard?state.game.tiles.flatMap((t,i)=>t.revealed&&!oldGame.tiles[i].revealed?[{index:i,front:$('board').children[i],correct:t.type===oldGame.turn}]:[]):[];
    room=state;game=state.game;filters=state.settings.filters;
    if(game?.phase==='clue' && game.round!==oldGame?.round)$('clueInput').value='';
    if(!previous || state.epoch!==previous.epoch){selected=null;if(connected)operation('');}
    if(!previous?.game && game){closeDialogs();$('clueInput').value='';$('matchRoster').open=false;}
    if(previous?.game && !game){hideTransition();closeDialogs();selected=null;}
    // Only a real settings edit invalidates an open pool dialog; a friend joining does not.
    // A host edit would be overwritten, so the host starts over; a read-only view just follows along.
    if(previous&&$('filterDialog').open&&JSON.stringify(previous.settings)!==JSON.stringify(state.settings)){
      if($('filterDialog').classList.contains('is-readonly'))showRoomFilters();else $('filterDialog').close();
    }
    revealing=flips.length>0;
    if(revealing)hideTransition();
    renderRoom();
    if(revealing){
      // Keep polling/action responses in order and prevent a local selection from replacing an animated card.
      document.querySelector('.game-layout').inert=true;
      try{await Promise.all(flips.map(({index,front,correct})=>animateReveal(index,front,correct)));}
      finally{revealing=false;document.querySelector('.game-layout').inert=false;}
      if(room!==state)return;
      if(game.phase==='over')renderRoom();else renderOnlineActions();
    }
    if(previous)announcePhase(oldGame,game);
    if(game?.phase==='over' && oldGame?.phase!=='over'){
      $('resultTitle').textContent=`${G.label(game.winner)}获胜！`;
      $('resultText').textContent=game.reason;openDialog('resultDialog');
    }
  }
  function playerRow(p) {
    const row=el('div','player-row'+(p.id===room.me?' is-me':'')+(p.online?'':' is-offline'));
    const name=el('span',game?'':'lobby-player-name',p.name);
    if(p.id===room.host)name.append(hostMark());
    if(game){
      row.append(name);
      if(!p.online)row.append(el('small','lobby-player-status is-offline','离线'));
    } else {
      const avatar=el('span','lobby-avatar',Array.from(p.name)[0]);avatar.setAttribute('aria-hidden','true');
      row.append(avatar,name);
      // A player still on the review screen holds no seat here yet; say so
      // instead of showing them as simply "not ready".
      const status=!p.online?'离线':p.inMatch?'看地图中':p.ready?'✓ 已准备':'未准备';
      row.append(el('small','lobby-player-status'+(p.ready&&!p.inMatch?' is-ready':'')+(p.online?'':' is-offline')+(p.inMatch&&p.online?' is-reviewing':''),status));
    }
    if(!p.online && room.me===room.host){const button=el('button','text-button','移除并回大厅');button.disabled=!connected;button.onclick=()=>command('kick',{player:p.id});row.append(button);}
    return row;
  }
  function renderRoom() {
    showEntry(false);lounge.hidden=false;
    const me=room.players.find(p=>p.id===room.me), host=room.me===room.host;
    lounge.classList.toggle('is-lobby',!game);
    $('roomCode').textContent=room.codeHidden?'••••••':room.code;
    $('roomCode').setAttribute('aria-label',room.codeHidden?'房间号已隐藏':room.code);
    const toggle=$('toggleCode'),toggleLabel=room.codeHidden?'显示房间号':'隐藏房间号';
    toggle.innerHTML=roomIcon(room.codeHidden?'eyeOff':'eye');toggle.title=toggleLabel;toggle.setAttribute('aria-label',toggleLabel);toggle.setAttribute('aria-pressed',String(room.codeHidden));toggle.disabled=!connected||!!pendingAction;
    $('myIdentity').replaceChildren(`${me.name} · ${me.team?G.label(me.team)+' / '+(me.role==='captain'?'队长':'猜词人'):'待选位置'}`);
    if(host)$('myIdentity').append(hostMark());
    $('myIdentity').hidden=!game;
    $('connectionState').textContent=connected?'':'正在重连…';
    $('lobbyControls').hidden=!!game;$('matchRoster').hidden=!game;
    // A player who has not left the review yet holds no seat: show them as
    // unassigned so the teams reflect who is actually available for the next round.
    const inLobby=p=>!p.inMatch, seatedPlayers=room.players.filter(inLobby);
    $('roomTeams').replaceChildren(...['red','blue'].map(team=>{
      const box=el('section','room-team '+team),heading=el('div','lobby-team-heading'),mark=el('span','lobby-team-mark',team==='red'?'✳':'✧');mark.setAttribute('aria-hidden','true');
      heading.append(mark,el('h3','',G.label(team)),el('span','lobby-team-count',`${seatedPlayers.filter(p=>p.team===team).length} 人`));box.append(heading);
      for(const role of ['captain','guesser']){
        const section=el('div','seat-section'),head=el('div','seat-heading');head.append(el('b','',role==='captain'?'队长':'猜词人'));
        const occupants=seatedPlayers.filter(p=>p.team===team&&p.role===role);
        const seated=me.team===team&&me.role===role,full=role==='captain'&&occupants.length>0;
        const button=el('button','button secondary'+(seated?' is-current':''),seated?'离座':full?'1 / 1':'加入 +');button.dataset.seat=team+'-'+role;
        button.setAttribute('aria-label',`${seated?'离座':full?'已满':'加入'}${G.label(team)}${role==='captain'?'队长':'猜词人'}`);
        button.disabled=!connected||!!pendingAction||(!seated&&full);
        button.onclick=()=>command('seat',seated?{team:null,role:'guesser'}:{team,role});head.append(button);section.append(head,...occupants.map(playerRow));
        if(!occupants.length){const empty=el('div','empty-seat'),icon=el('span','lobby-avatar','+');icon.setAttribute('aria-hidden','true');empty.append(icon,el('span','',role==='captain'?'队长空缺':'等你入座'));section.append(empty);}
        box.append(section);
      }
      return box;
    }));
    const unseated=seatedPlayers.filter(p=>!p.team),reviewing=room.players.filter(p=>p.inMatch),ready=seatedPlayers.filter(p=>p.ready).length;
    $('unseatedPlayers').replaceChildren(...[...unseated,...reviewing].map(playerRow));
    $('unseatedSection').hidden=!unseated.length&&!reviewing.length;$('unseatedCount').textContent=unseated.length+reviewing.length;
    const f=room.settings.filters;
    $('roomPoolCount').textContent=room.poolCount.toLocaleString();
    const scoreText=f.minScore===0&&f.maxScore===10?'全部评分':`${Number(f.minScore).toFixed(1)}–${Number(f.maxScore).toFixed(1)} 分`;
    const includeText=(f.included||[]).length?` · 含 ${(f.included||[]).join('、')}`:'';
    $('settingsSummary').textContent=`${f.minYear?`${f.minYear} — ${f.maxYear}`:`${f.maxYear} 年及以前`} · ${scoreText} · ≥ ${f.minVotes} 人评分${includeText}`;
    // Everyone can open the rules; only the host can move them. Reading the room
    // you are about to play in should not need permission.
    const roomRules=room.settings.rules;
    $('votingRule').value=room.settings.voting;
    $('maxFlipsRule').value=roomRules.maxFlips;
    $('freeCountRule').checked=roomRules.freeCount;
    $('banRule').checked=roomRules.ban;
    for(const id of ['votingRule','maxFlipsRule','freeCountRule','banRule'])$(id).disabled=!host||!connected||!!pendingAction;
    $('rulesSummary').textContent=[votingText[room.settings.voting],roomRules.maxFlips==='clue'?'每轮最多提示数 + 1 张':'每轮翻牌不限',...(roomRules.freeCount?['可不填张数']:[]),...(roomRules.ban?['队长禁牌']:[])].join(' · ');
    $('roomFilters').textContent=host?'调整牌池 ↗':'查看牌池 ↗';$('roomFilters').disabled=!connected;
    $('roomRules').textContent=host?'调整规则 ↗':'查看规则 ↗';
    $('readyButton').textContent=me.ready?'取消准备':'准备';$('readyButton').disabled=!me.team||!connected;
    $('readyButton').setAttribute('aria-pressed',String(me.ready));
    $('startRoom').hidden=!host;$('startRoom').disabled=room.blockers.length>0||!connected;
    $('readyCount').textContent=`${ready} / ${seatedPlayers.length} 人已准备`;
    document.querySelector('.ready-row').classList.toggle('all-ready',!room.blockers.length&&connected);
    $('startBlockers').textContent=!connected?'正在重新连接':!me.team?'选择队伍和位置，加入这场游戏':reviewing.length?`等待 ${reviewing.length} 位伙伴看完地图返回大厅`:room.players.some(p=>!p.online)?'等待离线玩家重连，或由房主移除':room.blockers.find(text=>/缺少队长|至少需要/.test(text))||(unseated.length?`等待 ${unseated.length} 位伙伴入座`:ready<seatedPlayers.length?`等待 ${seatedPlayers.length-ready} 位伙伴准备`:room.blockers[0]||(host?'全员就绪，随时开局':'全员就绪，等待房主开局'));
    $('leaveRoom').disabled=!connected;
    $('restartConfirm').disabled=!connected;$('againButton').disabled=!connected;
    if($('filterDialog').open){updatePoolCount();$('applyFilters').disabled ||= !connected||!!pendingAction;}
    const rosterRows=room.players.map(p=>{const row=playerRow(p);row.prepend(el('b','',p.team?G.label(p.team)+' '+(p.role==='captain'?'队长':'猜词人')+' · ':'未入座 · '));return row;});
    $('matchRosterList').replaceChildren(...rosterRows);
    const offline=room.players.filter(p=>!p.online).length;
    $('matchRosterSummary').textContent=`${room.players.length} 人`+(offline?` · ${offline} 人离线`:'');
    if(host && room.players.some(p=>!p.online))$('matchRoster').open=true;
    showGame(!!game);
    document.body.classList.toggle('on-lobby',!game);backdrop?.setMode(game?'match':'lobby');
    if(!game){backdrop?.setTeam(null);return;}
    view=me.role==='captain'||(game.phase==='over'&&!revealing)?'captain':'guesser';
    render(); renderOnlineActions();
  }
  function renderOnlineActions() {
    if(!game||!room)return;
    const me=room.players.find(p=>p.id===room.me), host=room.host===me.id, over=game.phase==='over';
    const ownTurn=me.team===game.turn;
    const guessingTurn=!over&&ownTurn&&me.role==='guesser'&&game.phase==='guess';
    const active=connected&&!pendingAction&&!over&&!revealing&&ownTurn;
    const canGuess=active&&guessingTurn;
    const team=G.label(game.turn), panel=document.querySelector('.turn-panel');
    roleBadge.textContent=`${G.label(me.team)} · ${me.role==='captain'?'队长':'猜词人'}`;
    roleBadge.dataset.team=me.team;
    panel.dataset.team=game.turn;backdrop?.setTeam(over?game.winner:game.turn);
    let state, title;
    if(over){state='over';title=`${G.label(game.winner)}获胜！`;}
    else if(!connected){state='reconnecting';title='正在重新连接';}
    else if(revealing){state='revealing';title='正在揭晓卡片';}
    else if(!ownTurn){state='opponent';title=G.actorText(game);}
    else if(game.phase==='clue'&&me.role==='captain'){state='act';title='轮到你出题';}
    else if(game.phase==='clue'){state='teammate';title=`${team}队长出题中`;}
    else if(me.role==='captain'){state='teammate';title=`${team}猜词人行动`;}
    else{state='act';title='轮到你猜词';}
    panel.dataset.state=state;
    $('turnTitle').textContent=title;
    $('phaseText').textContent=over?game.reason:'';
    waiting.hidden=over||state==='act';
    $('guesserView').disabled=true;$('captainView').disabled=revealing||(me.role!=='captain'&&!over);
    $('captainStart').hidden=true;
    $('clueForm').hidden=!(me.role==='captain'&&me.team===game.turn&&game.phase==='clue');
    $('clueForm').querySelector('button').disabled=!active;
    $('clueForm').querySelector('button').textContent=pendingAction==='clue'?'正在发布…':'发布提示 →';
    $('clueInput').disabled=!connected||pendingAction==='clue';$('numberInput').disabled=!connected||pendingAction==='clue';
    const roomRules=room.settings.rules;
    $('numberInput').placeholder=roomRules.freeCount?'不限':'';
    $('numberInput').setAttribute('aria-required',String(!roomRules.freeCount));
    // The ban is the captain's move, and only while they still hold the clue.
    // One button: it bans the selected card, or lifts the ban already in place.
    const banning=!over&&ownTurn&&me.role==='captain'&&game.phase==='clue'&&roomRules.ban;
    $('banCard').hidden=!banning;
    if(banning){
      // A fresh selection is the one to ban; otherwise the button lifts the ban.
      // Each team holds its own ban, and the other team's card cannot be taken over.
      const own=game.banned?.[me.team]??null;
      banTarget=selected!==null&&selected!==own&&!game.tiles[selected]?.revealed&&!G.bannedBy(game,selected)?selected:null;
      $('banCard').replaceChildren(banTarget===null&&own!==null?'取消禁用':'禁用',el('span','ban-mark inline','⊘'));
      $('banCard').dataset.banTeam=me.team;
      $('banCard').disabled=!active||(banTarget===null&&own===null);
    }
    $('clueDisplay').hidden=!$('clueForm').hidden;
    $('guesserActions').hidden=!guessingTurn;
    const ownVote=Object.hasOwn(room.votes,room.me)?room.votes[room.me]:null;
    $('confirmGuess').textContent=ownVote===selected&&ownVote!==null?'已投此牌':ownVote!==null?'改投此牌':'翻开';
    $('endTurn').textContent=ownVote==='end'?'已投结束':'结束回合';
    $('confirmGuess').disabled=!canGuess||selected===null||game.tiles[selected]?.revealed||ownVote===selected;
    $('endTurn').disabled=!canGuess||ownVote==='end';
    // The way back to the lobby is per player, so it stays until this player takes it.
    $('overActions').hidden=!over;
    $('backToLobby').disabled=!connected||!!pendingAction;
    $('reviewMap').hidden=view==='captain';
    $('filterButton').disabled=true;$('newButton').hidden=!host||over;$('newButton').disabled=!connected;
    $('clueWord').textContent=game.clue?.word||(over?'本局结束':'—');
    document.title=state==='act'?`${title} · 动画代号`:'动画代号 · Anime Code';
    const entries=Object.entries(room.votes);
    $('votePanel').hidden=game.phase!=='guess'||!entries.length;
    $('voteList').replaceChildren(...entries.map(([id,choice])=>{
      const row=el('p',id===room.me?'own-vote':'',`${room.players.find(p=>p.id===id)?.name} → ${choice==='end'?'结束回合':G.name(game.tiles[choice].anime)}`);
      return row;
    }));
    $('cancelVote').hidden=!guessingTurn||ownVote===null;
    $('cancelVote').disabled=!canGuess||!Object.hasOwn(room.votes,room.me);
    for(const [index,card] of [...$('board').children].entries()){
      card.querySelectorAll('.vote-badge,.own-vote-mark').forEach(n=>n.remove());
      card.classList.toggle('voted-by-me',ownVote===index);
      const count=entries.filter(([id,v])=>id!==room.me&&v===index).length;
      if(count){const badge=el('span','vote-badge',count+' 票');badge.title='其他玩家的投票';badge.setAttribute('aria-label',`其他玩家 ${count} 票`);card.append(badge);}
      if(ownVote===index)card.append(el('span','own-vote-mark','✓ 已投'));
      card.onclick=()=>{selected=selected===index?null:index;render();renderOnlineActions();$('board').children[index].focus({preventScroll:true});};
    }
  }
  $('createRoom').onclick=()=>enterRoom('create');
  $('joinRoomForm').onsubmit=e=>{e.preventDefault();enterRoom('join');};
  $('playerName').addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.isComposing||event.repeat)return;
    event.preventDefault();
    enterRoom($('roomCodeInput').value.trim()?'join':'create');
  });
  function setCopyFeedback(copied) {
    const button=$('copyCode'),label=copied?'已复制房间号':'复制房间号';
    button.innerHTML=roomIcon(copied?'check':'copy');button.classList.toggle('is-copied',copied);button.title=label;button.setAttribute('aria-label',label);
  }
  $('copyCode').onclick=async()=>{
    const identity=session;
    try{
      await navigator.clipboard.writeText(room.code);
      if(session!==identity)return;
      clearTimeout(copyTimer);setCopyFeedback(true);copyTimer=setTimeout(()=>setCopyFeedback(false),2000);
    }catch{if(session===identity)notice('复制失败，请显示房间号后手动复制。');}
  };
  $('toggleCode').onclick=()=>command('codeVisibility',{hidden:!room.codeHidden});
  $('leaveRoom').onclick=()=>{if(game?.phase!=='over'&&game&&!confirm('本局还没结束，离开会让全员返回大厅，确认离开？'))return;command('leave');};
  $('readyButton').onclick=()=>command('ready',{ready:!room.players.find(p=>p.id===room.me).ready});
  $('startRoom').onclick=()=>command('start');
  $('votingRule').onchange=()=>command('settings',{voting:$('votingRule').value});
  $('maxFlipsRule').onchange=()=>command('settings',{rules:{maxFlips:$('maxFlipsRule').value}});
  $('freeCountRule').onchange=()=>command('settings',{rules:{freeCount:$('freeCountRule').checked}});
  $('banRule').onchange=()=>command('settings',{rules:{ban:$('banRule').checked}});
  $('roomRules').onclick=()=>openDialog('rulesDialog');
  $('banCard').onclick=()=>command('ban',{index:banTarget});
  $('roomFilters').onclick=showRoomFilters;
  $('filterForm').onsubmit=e=>{e.preventDefault();updatePoolCount();if(!$('applyFilters').disabled)command('settings',{filters:readFilters()});};
  $('clueForm').onsubmit=e=>{
    e.preventDefault();
    if(!connected||pendingAction)return;
    const word=$('clueInput').value.trim(), raw=$('numberInput').value.trim();
    if(!word){operation('提示词不能为空。');$('clueInput').focus();return;}
    if(word.length>30){operation('提示词最多 30 个字符。');$('clueInput').focus();return;}
    if(/\s/.test(word)){operation('提示词不能包含空格。');$('clueInput').focus();return;}
    if(!raw&&!room?.settings.rules.freeCount){operation('本局必须填写提示张数。');$('numberInput').focus();return;}
    // A blank field is the unlimited clue, so it must not fall through to Number('') === 0.
    const count=raw===''?null:Number(raw);
    if(count!==null&&(!Number.isInteger(count)||count<0)){operation('提示张数必须是不小于 0 的整数。');$('numberInput').focus();return;}
    command('clue',{word,count});
  };
  $('confirmGuess').onclick=()=>{if(selected!==null)command('vote',{choice:selected});};
  $('endTurn').onclick=()=>command('vote',{choice:'end'});
  $('cancelVote').onclick=()=>command('vote',{choice:null});
  $('restartConfirm').onclick=()=>command('lobby');$('againButton').onclick=()=>command('lobby');
  $('backToLobby').onclick=()=>command('lobby');
  $('reviewMap').onclick=()=>{$('resultDialog').close();renderRoom();};
  $('reviewButton').onclick=()=>{$('resultDialog').close();renderRoom();};
  $('captainView').onclick=renderRoom;
  // Per-tab sessionStorage keeps normal new tabs independent and restores the seat on refresh.
  // A duplicated tab inherits sessionStorage: ask the original tab before resuming its identity.
  const channel = typeof BroadcastChannel==='function'?new BroadcastChannel('anicode-tabs'):null;
  const instance=crypto.randomUUID();
  channel?.addEventListener('message',({data})=>{
    if(!session||data.token!==session.token||data.instance===instance)return;
    if(data.type==='probe')channel.postMessage({type:'occupied',token:session.token,target:data.instance,instance});
    if(data.type==='occupied'&&data.target===instance){resetEntry();notice('这是一个独立玩家窗口，请输入昵称重新加入房间。');}
  });
  if(session)channel?.postMessage({type:'probe',token:session.token,instance});
  async function poll() {
    if(stopped)return;
    if(!session){pollTimer=null;return;}
    // A nudge landing mid-request is not lost: fetch again as soon as this one settles.
    if(polling){refreshSoon=true;return;}
    clearTimeout(pollTimer);polling=true;refreshSoon=false;connectPresence();
    await enqueue(async()=>{if(!session)return;try{const state=await api('/api/state?code='+encodeURIComponent(session.code));clearConnectionNotices();connected=true;syncConnectionStrip();await accept(state);}catch(error){handleError(error);}});
    polling=false;if(!stopped&&session)pollTimer=setTimeout(poll,refreshSoon?0:idleDelay());else pollTimer=null;
  }
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(pollTimer);disconnectPresence();});
  window.addEventListener('pageshow',e=>{if(e.persisted){stopped=false;connectPresence();poll();}});
  const resume=()=>{if(!document.hidden){connectPresence();poll();}};
  document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  fetch('anime_list.json').then(r=>r.json()).then(data=>{allAnime=data;if($('filterDialog').open)updatePoolCount();}).catch(()=>{$('dataFallback').hidden=false;});
  pollTimer=setTimeout(poll,150);
}
