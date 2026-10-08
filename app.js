'use strict';
const $=id=>document.getElementById(id), G=window.AniGame;
let allAnime=window.ANICODE_FALLBACK || [], dataDate=G.dataDate;
let filters={...G.defaults,excluded:[...G.defaults.excluded],included:[...(G.defaults.included||[])]}, game=null, view='guesser', selected=null, coverMode=localStorage.getItem('anicode-cover-mode')||(localStorage.getItem('anicode-show-covers')==='false'?'none':'adaptive');
let tagCatalog={exclude:[...G.excludedTags],include:[]};
// A mirror reachable without a proxy first, then the official host, then the relay.
const imageHosts=['bgmimg.anibt.net','lain.bgm.tv','lain.bangumi.lol'];
// The host that answered first on the last visit is tried first, so a returning
// player neither waits on a host that is down for them nor misses the covers
// the browser has already cached under that host's URLs.
const savedHost=localStorage.getItem('anicode-image-host');
if(imageHosts.includes(savedHost))imageHosts.unshift(...imageHosts.splice(imageHosts.indexOf(savedHost),1));
let hostSaved=false;
function saveHost(src){if(hostSaved)return;hostSaved=true;const host=new URL(src).hostname;if(imageHosts.includes(host))localStorage.setItem('anicode-image-host',host);}
const imageCache=new Map();
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function openDialog(id){if(!$(id).open)$(id).showModal();}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
function message(text=''){$('status').textContent=text;}
let transitionTimer;
function hideTransition(){clearTimeout(transitionTimer);if($('phaseTransition'))$('phaseTransition').hidden=true;}
function showTransition(team,title,detail){
  let panel=$('phaseTransition');
  if(!panel){
    panel=el('section','phase-transition');panel.id='phaseTransition';panel.hidden=true;
    const text=el('div');text.setAttribute('role','status');text.setAttribute('aria-live','polite');text.setAttribute('aria-atomic','true');
    const heading=el('strong');heading.id='transitionTitle';const description=el('p');description.id='transitionDetail';
    text.append(heading,description);const dismiss=el('button','icon-button','×');dismiss.type='button';dismiss.setAttribute('aria-label','关闭阶段提示');dismiss.onclick=hideTransition;
    panel.append(text,dismiss);document.querySelector('.turn-panel').append(panel);
  }
  hideTransition();panel.dataset.team=team;
  $('transitionTitle').textContent=title;$('transitionDetail').textContent=detail;
  // Cover the panel's own heading, which the banner restates, and nothing below it.
  const top=panel.parentElement.getBoundingClientRect().top;
  panel.style.minHeight=Math.max(64,Math.round($('turnTitle').getBoundingClientRect().bottom-top+12))+'px';
  panel.hidden=false;
  transitionTimer=setTimeout(hideTransition,2000);
}
// Wording lives in game.js so tests can assert it.
function announcePhase(previous,next){
  if(!next||next.phase==='over'){hideTransition();return;}
  const banner=G.announcement(previous,next);
  if(!banner)return;
  showTransition(banner.team,banner.title,banner.detail);
}
// Covers are adaptive (fit the screen), full or small (fixed sizes, board may scroll) or
// hidden; the older on/off setting maps onto adaptive or hidden.
const coverModes=['adaptive','full','small','none'];
function updateCoverToggle(){
  if(!coverModes.includes(coverMode))coverMode='adaptive';
  $('coverMode').value=coverMode;
  document.body.classList.toggle('full-covers',coverMode==='full');document.body.classList.toggle('small-covers',coverMode==='small');document.body.classList.toggle('no-covers',coverMode==='none');
}
// Card titles come in three sizes; medium is the original size.
const nameSizes=['small','medium','large'];
let nameSize=localStorage.getItem('anicode-name-size')||'medium';
function updateNameSize(){
  if(!nameSizes.includes(nameSize))nameSize='medium';
  $('nameSize').value=nameSize;
  document.body.classList.toggle('name-small',nameSize==='small');document.body.classList.toggle('name-large',nameSize==='large');
}
// Known cards show their team as a filled card (the default) or as coloured text on white.
const colorModes=['fill','text'];
let colorMode=localStorage.getItem('anicode-color-mode')||'fill';
function updateColorToggle(){
  if(!colorModes.includes(colorMode))colorMode='fill';
  $('colorMode').value=colorMode;
  document.body.classList.toggle('color-text',colorMode==='text');
}
// Desktop covers take the height left below the board's top edge, so all five rows fit on one screen.
function measureBoard(){
  const board=$('board');if(!board.offsetParent)return;
  const top=Math.round(board.getBoundingClientRect().top+scrollY)+'px',root=document.documentElement.style;
  if(root.getPropertyValue('--board-top')!==top)root.setProperty('--board-top',top);
}
function setView(next){view=next;selected=null;render();}
function requestCaptain(){if(!game)return;if(game.phase==='over')setView('captain');else if(view!=='captain')openDialog('privacyDialog');}
function start(){
  const pool=G.filter(allAnime,filters,dataDate);
  if(pool.length<25){message('当前候选池不足 25 部，请放宽筛选条件。');return;}
  game=G.create(pool);view='guesser';selected=null;closeDialogs();$('clueInput').value='';message('');render();announcePhase(null,game);
}
function coverImage(anime){
  const img=el('img');img.alt='';img.referrerPolicy='no-referrer';img.decoding='async';
  return applyCoverImage(img,anime)?img:null;
}
function applyCoverImage(img,anime,detail=false){
  img.onload=null;img.onerror=null;img.referrerPolicy='no-referrer';img.decoding='async';
  const hide=()=>{img.removeAttribute('src');img.style.display='none';if(detail)$('detailImageFallback').style.display='grid';};
  const path=String(anime.image_url||'').match(/^https?:\/\/[^/]+(\/.*)$/)?.[1];
  if(!path){hide();return false;}
  const cached=imageCache.get(path);if(cached===false){hide();return false;}
  const candidates=[...new Set([cached,...imageHosts.map(host=>'https://'+host+path)].filter(Boolean))];
  // A cover we have already loaded is in the browser cache, so show it straight
  // away. Hiding every image until onload makes the whole board blink on each
  // re-render, and the board is rebuilt on every click and every state poll.
  const known=typeof cached==='string';
  img.style.display=known?'block':'none';
  if(detail)$('detailImageFallback').style.display=known?'none':'grid';
  let attempt=0;
  img.onload=()=>{imageCache.set(path,img.currentSrc||img.src);saveHost(img.currentSrc||img.src);img.style.display='block';if(detail)$('detailImageFallback')?.style.setProperty('display','none');};
  img.onerror=()=>{attempt++;if(attempt<candidates.length)img.src=candidates[attempt];else{imageCache.set(path,false);img.removeAttribute('src');img.style.display='none';if(detail)$('detailImageFallback')?.style.setProperty('display','grid');}};
  img.src=candidates[0];
  return true;
}
function renderBoard(){
  $('board').classList.toggle('captain-board',view==='captain');
  const fragment=document.createDocumentFragment();
  game.tiles.forEach((tile,index)=>{
    const known=view==='captain'||tile.revealed;
    const coordinate=String.fromCharCode(65+Math.floor(index/5))+(index%5+1);
    const button=el('button','card'+(known?' known '+tile.type:'')+(tile.revealed?' revealed':'')+(selected===index?' selected':''));
    button.type='button';button.dataset.index=index;
    button.disabled=false;
    button.setAttribute('aria-pressed',String(selected===index));
    button.setAttribute('aria-label',`${coordinate} ${G.name(tile.anime)}${known?'，'+G.label(tile.type):''}${tile.revealed?'，已翻开':''}`);
    button.title=G.name(tile.anime);
    const cover=el('div','cover'),placeholder=el('div','cover-placeholder','✦');placeholder.append(el('small','','ANIME CODE'));cover.append(placeholder);
    const img=coverImage(tile.anime);if(img)cover.append(img);
    if(tile.revealed){const mark=el('div','reveal-mark');if(tile.type==='assassin')mark.append(el('b','','×'));cover.append(mark);}
    // Only the captains are told about a live ban, so the guessers still have to
    // read their own captain's clue; once the card is turned over its mark is
    // shown to everyone for the rest of the game. The mark carries
    // the banning team's colour, since both teams' bans can be live at once.
    const banTeam=tile.revealed||view==='captain'?G.bannedBy(game,index):null, banned=!!banTeam;
    if(banned){
      button.classList.add('is-banned');button.dataset.banTeam=banTeam;
      button.setAttribute('aria-label',button.getAttribute('aria-label')+`，${G.label(banTeam)}禁用牌`);
      cover.append(el('div','ban-mark','⊘'));
    }
    const title=el('div','card-name');
    // Covers can be hidden, so the name carries the mark too. It leads, because a
    // long name clamps to two lines and would push a trailing mark out of view.
    if(banned)title.append(el('span','ban-mark inline','⊘'));
    title.append(el('span','',G.name(tile.anime)));
    button.append(cover,title);
    button.onclick=()=>{selected=selected===index?null:index;render();$('board').children[index].focus({preventScroll:true});};
    fragment.append(button);
  });
  $('board').replaceChildren(fragment);
}
function flashCard(card,correct){
  if(!card||correct===undefined)return;
  card.classList.add(correct?'flash-correct':'flash-wrong');
  setTimeout(()=>card.classList.remove('flash-correct','flash-wrong'),800);
}
async function animateReveal(index,previousCard,correct){
  const card=$('board').children[index];
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||!card||!previousCard){flashCard(card,correct);return;}
  // Keep the original face visible until the card turns edge-on.
  const front=el('div','reveal-front');
  front.setAttribute('aria-hidden','true');
  front.append(...Array.from(previousCard.children,child=>child.cloneNode(true)));
  front.querySelectorAll('.vote-avatars,.reveal-front').forEach(n=>n.remove());
  if(previousCard.classList.contains('known')){
    front.classList.add('known-front');
    front.style.setProperty('--front-color',getComputedStyle(card).getPropertyValue('--card-color'));
  }
  card.append(front);
  card.classList.add('is-flipping');
  const animations=card.getAnimations({subtree:true});
  // Background animation clocks can stall. Finish on return instead of holding
  // the network update queue indefinitely behind an old cosmetic effect.
  const finish=()=>animations.forEach(animation=>{try{animation.finish();}catch{animation.cancel();}});
  const resume=()=>{if(!document.hidden)finish();};
  document.addEventListener('visibilitychange',resume);
  const deadline=setTimeout(finish,700);
  try{await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));}
  finally{clearTimeout(deadline);document.removeEventListener('visibilitychange',resume);}
  front.remove();
  card.classList.remove('is-flipping');
  flashCard(card,correct);
}
function render(){
  if(!game)return;
  const over=game.phase==='over', captain=view==='captain', guessing=game.phase==='guess';
  if(!document.body.classList.contains('multiplayer'))document.title=!over&&captain&&game.phase==='clue'?'轮到你出题 · 动画代号':!over&&!captain&&guessing?'轮到你猜词 · 动画代号':'动画代号 · Anime Code';
  renderBoard();
  renderDetail();
  for(const team of ['red','blue']){
    const total=team===(game.firstTeam||'red')?9:8, left=game.remaining?.[team]??G.remaining(game,team);
    $(team+'Remaining').textContent=left;$(team+'Remaining').title=`还剩 ${left} 部`;
    $(team+'Agents').replaceChildren(...Array.from({length:total},(_,i)=>el('i',i>=left?'found':'')));
    document.querySelector('.team.'+team).classList.toggle('active',!over&&game.turn===team);
  }
  $('round').textContent=over?'行动结束':`第 ${game.round} 回合`;
  $('guesserView').setAttribute('aria-pressed',String(!captain));$('captainView').setAttribute('aria-pressed',String(captain));
  // The legend only explains colours when the whole map is visible.
  $('boardLegend').hidden=!captain;
  $('turnTitle').textContent=over?`${G.label(game.winner)}获胜！`:`${G.label(game.turn)}的回合`;
  $('turnTitle').className=over?game.winner:game.turn;
  $('phaseText').textContent=over?'本局复盘':guessing?'猜词中':captain?'出题中':'等待队长出题';
  $('clueWord').textContent=game.clue?.word||'等待灵感';$('clueNumber').textContent=game.clue?(game.clue.count===null?'不限':game.clue.count):'—';
  $('clueDisplay').hidden=captain&&!guessing&&!over;
  // A capped round is worth stating: the budget decides when the turn ends, not
  // only the cards that come up.
  const left=G.flipsLeft(game);
  $('flipsLeft').hidden=over||!guessing||!Number.isFinite(left);
  if(!$('flipsLeft').hidden)$('flipsLeft').textContent=`本轮还可翻 ${left} 张`;
  $('clueForm').hidden=!captain||game.phase!=='clue';
  $('guesserActions').hidden=captain||!guessing;
  $('captainStart').hidden=captain||game.phase!=='clue';
  $('confirmGuess').disabled=captain||!guessing||selected===null;
  $('endTurn').disabled=captain||!guessing;
  renderLog();
}
// The action log replays the game a round at a time: each team's clue, then the
// cards it turned, in order. Two team turns make a round, so `g.round` 1–2 is the
// first page. It follows the newest round until the player pages back; the pin is
// tied to the deal, so a new game starts on its newest round again.
let logPin=null,logOpen=localStorage.getItem('anicode-log-open')!=='false';
const logDeal=g=>g.tiles.map(t=>t.anime.id).join();
const logPageOf=round=>Math.floor((round-1)/2);
function logPages(){const turns=game.turns||[];return logPageOf(game.phase==='over'?(turns.at(-1)?.round||1):game.round);}
function renderLog(){
  const panel=document.querySelector('.log-panel'),turns=game.turns||[];
  // Nothing to show before the first clue; a game stored before the record existed has none at all.
  panel.hidden=!game.turns||!turns.length&&game.round===1;
  if(panel.hidden)return;
  // Folded away, the panel keeps only its heading.
  panel.classList.toggle('collapsed',!logOpen);$('logToggle').setAttribute('aria-expanded',String(logOpen));
  if(!logOpen)return;
  const last=logPages(),pinned=logPin?.deal===logDeal(game)?logPin.page:null,shown=pinned===null?last:Math.min(pinned,last);
  $('logPage').textContent=`第 ${shown+1} / ${last+1} 轮`;
  $('logPrev').disabled=shown===0;$('logNext').disabled=shown===last;$('logLatest').hidden=shown===last;
  const live=game.phase==='guess'?turns.at(-1):null;
  const rows=turns.filter(t=>logPageOf(t.round)===shown).map(t=>logTurn(t,t!==live));
  // The captain of this turn is still thinking, so the round's slot waits for the clue.
  if(game.phase==='clue'&&shown===last&&!turns.some(t=>t.round===game.round)){
    const box=el('div','log-turn '+game.turn);box.append(logHead(game.turn),el('p','log-wait','等待队长给出提示'));rows.push(box);
  }
  $('logBody').replaceChildren(...rows);
}
function logHead(team){const head=el('div','log-head');head.append(el('i'),el('b','',G.label(team)));return head;}
function logTurn(t,ended){
  const box=el('div','log-turn '+t.team),clue=el('div','log-clue');
  box.append(logHead(t.team),clue);
  if(t.word===null)clue.append(el('strong','muted','未出题'));
  else{
    const hits=t.flips.filter(i=>game.tiles[i].type===t.team).length,short=ended&&t.count!==null&&hits<t.count;
    clue.append(el('strong','',t.word),el('em','',t.count===null?'不限':String(t.count)));
    // What the replay is for: a clue that still has cards left to find stands out.
    clue.append(el('span','log-hit'+(short?' short':''),short?`猜中 ${hits} · 差 ${t.count-hits}`:`猜中 ${hits}`));
  }
  if(t.flips.length){
    const flips=el('ol','log-flips');
    for(const i of t.flips){
      const tile=game.tiles[i],item=el('li','log-flip '+tile.type+(tile.type===t.team?' hit':''));
      item.title=G.name(tile.anime);
      const cover=el('div','log-cover'),img=coverImage(tile.anime);if(img)cover.append(img);
      const name=el('span','log-name');
      if(tile.bannedBy){item.dataset.banTeam=tile.bannedBy;name.append(el('span','ban-mark inline','⊘'));}
      name.append(G.name(tile.anime));
      item.append(cover,name,el('small','log-tag',{red:'红',blue:'蓝',neutral:'中立',assassin:'刺客'}[tile.type]));
      flips.append(item);
    }
    box.append(flips);
  }
  return box;
}
function pinLog(page){logPin=page>=logPages()?null:{deal:logDeal(game),page:Math.max(0,page)};renderLog();}
const filterKeys=['minVotes','minYear','maxYear','minScore','maxScore'];
// A preset is just the numeric dials, so it never touches the tag choices the
// host has made. Chips stay reflective: whichever one matches the current dials
// reads as pressed, and moving any slider drops that state on its own.
function presetMatches(preset){return G.presetKeys.every(key=>Number($(key).value||0)===preset.filters[key]);}
function syncPresetChips(){
  for(const chip of $('presetChips').children)
    chip.setAttribute('aria-pressed',String(presetMatches(G.presets[Number(chip.dataset.preset)])));
}
function applyPreset(preset){
  for(const key of G.presetKeys){
    $(key).value=key==='minYear'&&!preset.filters[key]?'':preset.filters[key];
    syncFilterRange(key);
  }
  syncPresetChips();updatePoolCount();
}
$('presetChips').replaceChildren(...G.presets.map((preset,index)=>{
  // type=button, or the chip would submit the filter form and reroll the board.
  const chip=el('button','preset-chip',preset.name);chip.type='button';chip.dataset.preset=index;
  chip.setAttribute('aria-pressed','false');chip.title=preset.hint;
  chip.onclick=()=>applyPreset(preset);
  return chip;
}));
function readFilters(){
  return {...Object.fromEntries(filterKeys.map(key=>[key,Number($(key).value)])),
    excluded:[...$('excludeTags').querySelectorAll('input:checked')].map(n=>n.value),
    included:[...$('includeTags').querySelectorAll('input:checked')].map(n=>n.value),
    excludeOptions:[...tagCatalog.exclude],includeOptions:[...tagCatalog.include]};
}
function updatePoolCount(){
  const f=readFilters(),valid=$('filterForm').checkValidity()&&f.minYear<=f.maxYear&&f.minScore<=f.maxScore;
  const count=valid?G.filter(allAnime,f,dataDate).length:0;
  $('poolCount').textContent=!valid?'请检查数值、年份和评分范围。':`候选池：${count.toLocaleString()} 部${count<25?' · 至少需要 25 部，请放宽条件':''}`;
  $('applyFilters').disabled=!valid||count<25;
}
function syncFilterRange(key){
  const number=$(key),range=$(key+'Range'),value=Number(number.value);
  if(key==='minVotes'){range.max=Math.max(5000,value||0);$('votesRangeMax').textContent=Number(range.max).toLocaleString()+' 人';}
  range.value=key==='minYear'&&!value?range.min:value;
  range.style.setProperty('--range-fill',((Number(range.value)-Number(range.min))/(Number(range.max)-Number(range.min))*100)+'%');
  range.setAttribute('aria-valuetext',key==='minYear'&&range.value===range.min?'不限':range.value);
}
for(const key of filterKeys){
  $(key+'Range').oninput=()=>{
    $(key).value=key==='minYear'&&$(key+'Range').value===$(key+'Range').min?'':$(key+'Range').value;
    syncFilterRange(key);syncPresetChips();
  };
  $(key).oninput=()=>{syncFilterRange(key);syncPresetChips();};
}
function renderTagFilters(selected=filters){
  for(const kind of ['exclude','include']){
    const tags=tagCatalog[kind],active=selected[kind==='exclude'?'excluded':'included']||[];
    $(kind+'Tags').replaceChildren(...tags.map(tag=>{
      const row=el('div','tag-option'),label=el('label'),check=el('input');
      check.type='checkbox';check.value=tag;check.checked=active.includes(tag);
      label.append(check,el('span','',tag));row.append(label);
      if(kind!=='exclude'||!G.excludedTags.includes(tag)){
        const remove=el('button','tag-remove','×');remove.type='button';
        remove.setAttribute('aria-label',`删除${kind==='exclude'?'排除':'包含'}标签 ${tag}`);
        remove.onclick=()=>{
          const selected=readFilters();tagCatalog[kind]=tags.filter(item=>item!==tag);
          renderTagFilters(selected);$('tagStatus').textContent='';updatePoolCount();$(kind+'TagInput').focus();
        };
        row.append(remove);
      }
      return row;
    }));
    $(kind+'TagsEmpty').hidden=tags.length>0;
  }
}
function addTag(kind){
  const input=$(kind+'TagInput'),tag=input.value.trim(),selected=readFilters();
  if(!tag)return;
  if(tag.length>30){$('tagStatus').textContent='标签最多 30 个字符。';return;}
  if(!tagCatalog[kind].includes(tag)){
    if(tagCatalog[kind].length>=100){$('tagStatus').textContent='每栏最多添加 100 个标签。';return;}
    tagCatalog[kind].push(tag);
  }
  selected[kind==='exclude'?'excluded':'included'].push(tag);
  renderTagFilters(selected);input.value='';$('tagStatus').textContent='';updatePoolCount();input.focus();
}
function showFilters(){
  for(const key of filterKeys){$(key).value=key==='minYear'&&!filters[key]?'':filters[key];syncFilterRange(key);}
  tagCatalog={
    exclude:[...new Set([...G.excludedTags,...(filters.excludeOptions||[]),...(filters.excluded||[])])],
    include:[...new Set([...(filters.includeOptions||[]),...(filters.included||[])])]
  };
  $('excludeTagInput').value='';$('includeTagInput').value='';$('tagStatus').textContent='';
  if($('filterNotice'))$('filterNotice').textContent='';
  renderTagFilters();syncPresetChips();updatePoolCount();openDialog('filterDialog');
}
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
$('helpButton').onclick=()=>openDialog('helpDialog');
function openGuideFromHelp(){$('helpDialog').close();window.AniDemo?.openGuide();}
$('helpGuide').onclick=openGuideFromHelp;$('newButton').onclick=()=>openDialog('newDialog');
$('restartConfirm').onclick=start;$('againButton').onclick=start;
$('guesserView').onclick=()=>setView('guesser');$('captainView').onclick=requestCaptain;$('captainStart').onclick=requestCaptain;
$('unlockMap').onclick=()=>{$('privacyDialog').close();setView('captain');if(game.phase==='clue')$('clueInput').focus();};
// An empty number field is the "flip as many as you like" clue, so it is read as
// null rather than coerced to 0.
function clueCount(){const raw=$('numberInput').value.trim();return raw===''?null:Number(raw);}
$('clueForm').onsubmit=event=>{event.preventDefault();if(view!=='captain')return;const previous={...game};if(!G.giveClue(game,$('clueInput').value,clueCount())){message('请输入一个不含空格的提示词，张数留空或填不小于 0 的整数。');return;}$('clueInput').value='';message('');setView('guesser');announcePhase(previous,game);};
$('confirmGuess').onclick=async()=>{
  if(view!=='guesser'||selected===null)return;
  const index=selected,previousCard=$('board').children[index],currentGame=game,previous={...game};
  const result=G.guess(game,index);if(!result)return;
  selected=null;
  message(game.phase==='over'?game.reason:result.type===result.actor?'猜中己方':`翻到${G.label(result.type)}牌`);
  render();
  await animateReveal(index,previousCard,result.type===result.actor);
  if(game===currentGame)announcePhase(previous,game);
  if(game===currentGame&&game.phase==='over'&&view==='guesser'){$('resultTitle').textContent=G.label(game.winner)+'获胜！';$('resultText').textContent=game.reason;openDialog('resultDialog');}
};
$('endTurn').onclick=()=>{const previous={...game};if(view==='guesser'&&G.stop(game)){selected=null;message('');render();announcePhase(previous,game);}};
$('logPrev').onclick=()=>pinLog((logPin?.deal===logDeal(game)?logPin.page:logPages())-1);
$('logNext').onclick=()=>pinLog((logPin?.deal===logDeal(game)?logPin.page:logPages())+1);
$('logLatest').onclick=()=>pinLog(Infinity);
$('logToggle').onclick=()=>{logOpen=!logOpen;localStorage.setItem('anicode-log-open',String(logOpen));renderLog();};
$('reviewButton').onclick=()=>{$('resultDialog').close();setView('captain');};
$('coverMode').onchange=e=>{coverMode=e.target.value;localStorage.setItem('anicode-cover-mode',coverMode);localStorage.removeItem('anicode-show-covers');updateCoverToggle();};
$('nameSize').onchange=e=>{nameSize=e.target.value;localStorage.setItem('anicode-name-size',nameSize);updateNameSize();};
$('colorMode').onchange=e=>{colorMode=e.target.value;localStorage.setItem('anicode-color-mode',colorMode);updateColorToggle();};
$('filterButton').onclick=showFilters;$('filterForm').oninput=updatePoolCount;
$('addExcludeTag').onclick=()=>addTag('exclude');$('addIncludeTag').onclick=()=>addTag('include');
for(const kind of ['exclude','include'])$(kind+'TagInput').onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();addTag(kind);}};
$('filterForm').onsubmit=event=>{event.preventDefault();updatePoolCount();if($('applyFilters').disabled)return;filters=readFilters();start();};
// Switching away automatically conceals the map without changing any revealed cards.
document.addEventListener('visibilitychange',()=>{if(!document.body.classList.contains('multiplayer')&&document.hidden&&view==='captain'&&game?.phase!=='over')setView('guesser');});
async function load(){
  if(location.protocol!=='file:'){
    try{const response=await fetch('anime_list.json');if(!response.ok)throw new Error('data unavailable');const data=await response.json();if(!Array.isArray(data)||data.length<25)throw new Error('invalid data');allAnime=data;}catch{$('dataFallback').hidden=false;}
  } else $('dataFallback').hidden=false;
  start();
}
// The dataset cutoff drives the footer date and the newest selectable year.
$('dataUpdated').textContent=G.dataDate.slice(2).replaceAll('-','.');
for(const id of ['minYear','maxYear']){$(id).max=G.dataYear;$(id+'Range').max=G.dataYear;}
for(const node of document.querySelectorAll('[data-year-max]'))node.textContent=`${G.dataYear} 年`;
updateCoverToggle();updateNameSize();updateColorToggle();
const boardObserver=new ResizeObserver(measureBoard);for(const node of [$('board'),...document.querySelectorAll('.header,.scoreboard,.toolbar')])boardObserver.observe(node);
if(location.protocol==='file:' || new URLSearchParams(location.search).has('local'))load();
function renderDetail(){
  const panel=$('detailPanel'),content=$('detailContent');
  panel.hidden=selected===null||!game;
  if(panel.hidden)return;
  const anime=game.tiles[selected].anime;content.hidden=false;
  $('detailName').textContent=G.name(anime);
  const year=(anime.air_date||'').slice(0,4),score=anime.score?`评分 ${anime.score}`:'';
  $('detailMeta').textContent=[year,score,anime.vote_count?`${Number(anime.vote_count).toLocaleString()} 人评分`:'' ].filter(Boolean).join(' · ')||'Bangumi 条目';
  const image=$('detailImage');image.alt=G.name(anime);
  applyCoverImage(image,anime,true);
  $('detailLink').href=anime.id?`https://bgm.tv/subject/${anime.id}`:'https://bgm.tv';
}
