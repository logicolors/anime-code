const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startWorker}=require('./worker-server.cjs');
const G=require('../game.js');
const data=require('../anime_list.json');
(async()=>{
 const worker=await startWorker();
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1360,height:1080}});
  await context.route(/https:\/\//,route=>route.abort());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const base=worker.base;
  const tag=(kind,name)=>page.locator('#'+kind+'Tags').getByRole('checkbox',{name,exact:true});
  const add=async(kind,name)=>{await page.fill('#'+kind+'TagInput',name);await page.click(kind==='exclude'?'#addExcludeTag':'#addIncludeTag');};
  await page.goto(base);await page.fill('#playerName','筛选测试');await page.click('#createRoom');
  await page.waitForFunction(()=>allAnime.length>200);
  await page.click('#roomFilters');
  await expect(page.locator('#filterForm input[type=range]')).toHaveCount(5);
  // Presets are the cold-start path: one chip, a whole pool, no dialog left open.
  await expect(page.locator('.preset-chip')).toHaveCount(5);
  await expect(page.locator('.preset-chip[aria-pressed=true]')).toHaveCount(0);
  await page.getByRole('button',{name:'近五年',exact:true}).click();
  await expect(page.locator('#filterDialog')).toBeVisible();
  await expect(page.locator('#minYear')).toHaveValue(String(G.dataYear-4));
  await expect(page.locator('#minYearRange')).toHaveValue(String(G.dataYear-4));
  await expect(page.locator('#maxYear')).toHaveValue(String(G.dataYear));
  await expect(page.getByRole('button',{name:'近五年',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.preset-chip[aria-pressed=true]')).toHaveCount(1);
  const presetPool=await page.evaluate(()=>G.filter(allAnime,readFilters(),G.dataDate).length);
  assert.ok(presetPool>=25,'a preset must never leave the pool unplayable');
  await expect(page.locator('#poolCount')).toHaveText('候选池：'+presetPool.toLocaleString()+' 部');
  await expect(page.locator('#applyFilters')).toBeEnabled();
  // Nudging any dial by hand drops the chip's pressed state.
  await page.locator('#minYearRange').focus();await page.keyboard.press('ArrowRight');
  await expect(page.locator('.preset-chip[aria-pressed=true]')).toHaveCount(0);
  await page.getByRole('button',{name:'人气佳作',exact:true}).click();
  await expect(page.locator('#minVotes')).toHaveValue('2500');await expect(page.locator('#minScore')).toHaveValue('7');
  await expect(page.locator('#minYear')).toHaveValue('');
  // A preset moves the dials only: the host's tag choices survive it.
  await add('include','预设保留');
  await page.getByRole('button',{name:'热门',exact:true}).click();
  await expect(tag('include','预设保留')).toBeChecked();
  await page.getByRole('button',{name:'删除包含标签 预设保留',exact:true}).click();
  await page.fill('#minVotes','500');await page.fill('#minYear','');await page.fill('#maxYear',String(G.dataYear));
  await page.fill('#minVotes','600');await expect(page.locator('#minVotesRange')).toHaveValue('600');
  await page.locator('#minVotesRange').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#minVotes')).toHaveValue('601');
  await page.fill('#minVotes','500');
  await page.fill('#minYear','2000');await expect(page.locator('#minYearRange')).toHaveValue('2000');
  await page.locator('#minYearRange').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#minYear')).toHaveValue('2001');
  await page.fill('#minYear','');
  await page.fill('#maxYear','2024');await expect(page.locator('#maxYearRange')).toHaveValue('2024');await page.fill('#maxYear','2026');
  await page.locator('#minScoreRange').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
  await expect(page.locator('#minScore')).toHaveValue('0.1');
  await page.fill('#minScore','6');await expect(page.locator('#minScoreRange')).toHaveValue('6');
  await page.fill('#maxScore','9');await expect(page.locator('#maxScoreRange')).toHaveValue('9');
  await page.fill('#maxScore','5');await expect(page.locator('#applyFilters')).toBeDisabled();
  await page.fill('#maxScore','9.05');await expect(page.locator('#applyFilters')).toBeDisabled();
  await page.fill('#maxScore','9');
  await tag('exclude','剧场版').uncheck();
  await add('include','音乐');await add('include','TV');
  await expect(tag('exclude','剧场版')).not.toBeChecked();await expect(tag('include','音乐')).toBeChecked();
  await add('exclude','原创');
  await add('include','未勾选的标签');await tag('include','未勾选的标签').uncheck();
  await add('exclude','未勾选排除');await tag('exclude','未勾选排除').uncheck();
  await add('include','音乐');await expect(tag('include','音乐')).toHaveCount(1);
  await expect(tag('include','未勾选的标签')).not.toBeChecked();
  await add('include','删除测试');await page.getByRole('button',{name:'删除包含标签 删除测试',exact:true}).click();
  await expect(tag('include','删除测试')).toHaveCount(0);
  await expect(tag('include','TV')).toBeChecked();await expect(tag('exclude','原创')).toBeChecked();
  await page.fill('#includeTagInput','OVA');await page.locator('#includeTagInput').press('Enter');
  await expect(page.locator('#filterDialog')).toBeVisible();await expect(page.locator('#applyFilters')).toBeDisabled();
  await page.getByRole('button',{name:'删除包含标签 OVA',exact:true}).click();
  await expect(tag('exclude','OVA')).toBeChecked();
  const selected=await page.evaluate(()=>readFilters());
  const expected=G.filter(data,selected).length;assert.ok(expected>=25);
  await expect(page.locator('#poolCount')).toHaveText('候选池：'+expected.toLocaleString()+' 部');
  fs.mkdirSync('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/filters-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.getElementById('filterDialog').scrollTop=0);
  await page.screenshot({path:'artifacts/filters-mobile.png'});
  assert.ok(await page.evaluate(()=>{
   const dialog=document.getElementById('filterDialog'),left=document.getElementById('excludeTags').getBoundingClientRect(),right=document.getElementById('includeTags').getBoundingClientRect();
   return dialog.scrollWidth<=dialog.clientWidth && document.documentElement.scrollWidth<=innerWidth && left.x<right.x;
  }));
  await page.evaluate(()=>document.getElementById('filterDialog').scrollTop=document.getElementById('filterDialog').scrollHeight);
  await page.screenshot({path:'artifacts/filters-mobile-tags.png'});
  const saveBounds=await page.locator('#applyFilters').boundingBox();assert.ok(saveBounds.y+saveBounds.height<=844);
  await page.click('#applyFilters');await expect(page.locator('#filterDialog')).not.toBeVisible();
  await expect(page.locator('#roomPoolCount')).toHaveText(expected.toLocaleString());
  await page.reload();await page.click('#roomFilters');await page.waitForFunction(()=>allAnime.length>200);
  await expect(tag('include','未勾选的标签')).not.toBeChecked();await expect(tag('exclude','未勾选排除')).not.toBeChecked();
  await expect(tag('exclude','剧场版')).not.toBeChecked();await expect(tag('include','音乐')).toBeChecked();
  await expect(page.locator('#minScore')).toHaveValue('6');await expect(page.locator('#maxScore')).toHaveValue('9');
  await tag('include','音乐').uncheck();await add('exclude','取消测试');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.click('#roomFilters');await expect(tag('include','音乐')).toBeChecked();await expect(tag('exclude','取消测试')).toHaveCount(0);
  await page.getByRole('button',{name:'删除排除标签 未勾选排除',exact:true}).click();
  await page.click('#applyFilters');await expect(page.locator('#filterDialog')).not.toBeVisible();
  await page.click('#roomFilters');await expect(tag('exclude','未勾选排除')).toHaveCount(0);
  // Bangumi import, against a stand-in API. The official host fails for one user,
  // so the mirror has to take over; unknown users get Bangumi's own 404 body. A
  // UID of an account with a name set is turned into the name by the old API.
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.setViewportSize({width:1360,height:1080});
  const known=data.slice(0,200).map(a=>a.id),requests=[];
  const lists={tester:[...known.slice(0,70).map(id=>[id,2]),...known.slice(70,90).map(id=>[id,3]),...known.slice(90,100).map(id=>[id,1]),[999999999,2]],
   friend:[...known.slice(60,80).map(id=>[id,2]),...known.slice(100,140).map(id=>[id,5])],
   fallback:known.slice(140,180).map(id=>[id,2]),
   named:known.slice(180,200).map(id=>[id,2])};
  await context.route(/^https:\/\/api\.(bgm\.tv|bangumi\.vip)\/(v0\/)?users?\//,route=>{
   const url=new URL(route.request().url()),parts=url.pathname.split('/'),headers={'Access-Control-Allow-Origin':'*'};
   if(parts[1]==='user'){
    requests.push(url.host+' uid '+parts[2]);
    const body=parts[2]==='4242'?{id:4242,username:'named',nickname:'Named'}:{request:url.pathname,code:404,error:'Not Found'};
    return route.fulfill({headers,contentType:'application/json',body:JSON.stringify(body)});
   }
   const user=decodeURIComponent(parts[3]);requests.push(url.host+' '+user+' '+url.searchParams.get('offset'));
   if(user==='fallback'&&url.host==='api.bgm.tv')return route.fulfill({status:502,headers,body:'bad gateway'});
   if(!lists[user])return route.fulfill({status:404,headers,contentType:'application/json',body:JSON.stringify({title:'Not Found',description:'user doesn\'t exist or has been removed'})});
   const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit')),all=lists[user];
   route.fulfill({headers,contentType:'application/json',body:JSON.stringify({total:all.length,limit,offset,data:all.slice(offset,offset+limit).map(([id,type])=>({subject_id:id,subject_type:2,type,rate:0,tags:[],ep_status:0,vol_status:0,updated_at:'',private:false}))})});
  });
  await page.click('#roomFilters');
  // The filter dialog only carries a summary; the import lives in its own dialog.
  await expect(page.locator('#poolSummary')).toHaveText('未导入，从全部动画中抽取。');
  await expect(page.locator('#bangumiUser')).toBeHidden();
  // The tags and scores set above would leave little of a 200-anime list.
  await tag('include','音乐').uncheck();await tag('include','TV').uncheck();
  await page.fill('#minScore','0');await page.fill('#maxScore','10');
  await page.click('#openBangumi');
  await expect(page.locator('#bangumiDialog')).toBeVisible();await expect(page.locator('#bangumiUser')).toBeFocused();
  await expect(page.locator('#poolPanel')).toBeHidden();
  await page.fill('#bangumiUser','nobody');await page.click('#readBangumi');
  await expect(page.locator('#bangumiStatus')).toHaveText('找不到 Bangumi 用户「nobody」。');
  assert.ok(!requests.some(r=>r.includes(' uid ')),'a name is never looked up as a UID');
  await page.fill('#bangumiUser','99');await page.click('#readBangumi');
  await expect(page.locator('#bangumiStatus')).toHaveText('找不到 Bangumi 用户「99」。');
  await page.fill('#bangumiUser','tester');await page.locator('#bangumiUser').press('Enter');
  await expect(page.locator('#poolPanel')).toBeVisible();
  // Watched and watching start ticked, wish-list entries are listed but not.
  await expect(page.locator('#poolPicked')).toHaveText('已选 90 / 100');
  await expect(page.locator('#poolMissing')).toHaveText('另有 1 部收藏不在动画数据中，无法加入牌池。');
  await expect(page.locator('#minVotes')).toHaveValue('0');
  assert.equal(requests.filter(r=>r.includes(' tester ')).length,3,'101 items are three pages of 50');
  assert.ok(requests.filter(r=>r.includes(' tester ')).every(r=>r.startsWith('api.bgm.tv ')),'the official API is tried first');
  const pickedPool=()=>page.evaluate(()=>G.filter(allAnime,readFilters(),G.dataDate).length);
  await expect(page.locator('#poolCount')).toHaveText(`收藏牌池：已选 90 部 · 筛选后 ${(await pickedPool()).toLocaleString()} 部`);
  const wish=page.locator('.pool-group[data-type="1"]');
  await expect(wish).toHaveClass(/is-collapsed/);await wish.getByRole('button',{name:'展开'}).click();
  await wish.locator('.pool-group-check').check();await expect(page.locator('#poolPicked')).toHaveText('已选 100 / 100');
  const watching=page.locator('.pool-group[data-type="3"]');
  await watching.locator('.pool-option input').first().uncheck();
  assert.equal(await watching.locator('.pool-group-check').evaluate(n=>n.indeterminate),true);
  await expect(watching.locator('.pool-group-count')).toHaveText('19 / 20');
  // A second user merges in: overlap is listed once, under the better type, and
  // only the new anime pick up the default ticks.
  await page.fill('#bangumiUser','friend');await page.click('#readBangumi');
  await expect(page.locator('#poolPicked')).toHaveText('已选 99 / 140');
  await expect(page.locator(".pool-option",{hasText:G.name(data[75])}).first().locator("small")).toContainText('tester、friend');
  await page.fill('#bangumiUser','fallback');await page.click('#readBangumi');
  await expect(page.locator('#poolPicked')).toHaveText('已选 139 / 180');
  assert.ok(requests.includes('api.bangumi.vip fallback 0'),'a failing official API hands over to the mirror');
  await page.fill('#bangumiUser','4242');await page.click('#readBangumi');
  await expect(page.locator('#bangumiStatus')).toHaveText('已读取「named（UID 4242）」的 20 部动画收藏。');
  await expect(page.locator('#poolPicked')).toHaveText('已选 159 / 200');
  assert.ok(requests.includes('api.bgm.tv uid 4242')&&requests.includes('api.bgm.tv named 0'),'the UID resolves to the name, then the name is read');
  await page.fill('#bangumiUser','named');await page.click('#readBangumi');
  await expect(page.locator('#bangumiStatus')).toHaveText('已经导入了「named」的收藏。');
  await expect(page.locator('.bangumi-user')).toHaveText(['tester×','friend×','fallback×','named×']);
  await page.fill('#poolSearch',G.name(data[0]));
  await expect(page.locator('.pool-option:visible')).toHaveCount(await page.locator('.pool-option').evaluateAll((rows,q)=>rows.filter(r=>r.dataset.search.includes(q.toLowerCase())).length,G.name(data[0])));
  await page.fill('#poolSearch','');
  await page.screenshot({path:'artifacts/filters-bangumi.png'});
  assert.ok(await page.evaluate(()=>{const d=document.getElementById('bangumiDialog');return d.scrollWidth<=d.clientWidth;}),'the import dialog does not scroll sideways');
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await expect(page.locator('#bangumiDialog')).toBeHidden();await expect(page.locator('#filterDialog')).toBeVisible();
  await expect(page.locator('#poolSummary')).toHaveText('tester、friend、fallback、named · 已选 159 部');
  await expect(page.locator('#openBangumi')).toHaveText('编辑收藏');
  const savedIds=await page.evaluate(()=>readFilters().poolIds),poolTotal=await pickedPool();
  assert.equal(savedIds.length,159);
  await page.click('#applyFilters');await expect(page.locator('#filterDialog')).not.toBeVisible();
  await expect(page.locator('#roomPoolCount')).toHaveText(poolTotal.toLocaleString());
  await expect(page.locator('#settingsSummary')).toContainText('Bangumi 收藏（tester、friend、fallback、named · 159 部）');
  // After a reload the saved ticks come back as they were, regrouped once the
  // collections are read again.
  await page.reload();await page.waitForFunction(()=>allAnime.length>200);await page.click('#roomFilters');
  await expect(page.locator('#poolSummary')).toHaveText('tester、friend、fallback、named · 已选 159 部');
  await page.click('#openBangumi');
  await expect(page.locator('#poolPicked')).toHaveText('已选 159 / 200');
  // Until every saved user is read again, removing one could not tell what was theirs.
  await expect(page.getByRole('button',{name:'移除 fallback 的收藏'})).toBeEnabled();
  await expect(page.locator('.pool-group[data-type="0"]')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>readFilters().poolIds),savedIds);
  // Removing a user drops what only they collected.
  await page.getByRole('button',{name:'移除 fallback 的收藏'}).click();
  await expect(page.locator('#poolPicked')).toHaveText('已选 119 / 160');
  await page.getByRole('button',{name:'清除导入，改回全部动画'}).click();
  await expect(page.locator('#poolPanel')).toBeHidden();
  assert.equal(await page.evaluate(()=>readFilters().poolIds),null);
  // Escape only closes the import dialog, back to the filters.
  await page.keyboard.press('Escape');await expect(page.locator('#bangumiDialog')).toBeHidden();await expect(page.locator('#filterDialog')).toBeVisible();
  await expect(page.locator('#poolSummary')).toHaveText('未导入，从全部动画中抽取。');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.click('#roomFilters');
  await expect(page.locator('#poolSummary')).toHaveText('tester、friend、fallback、named · 已选 159 部');
  await page.click('#openBangumi');
  await expect(page.locator('#poolPicked')).toHaveText('已选 159 / 200');
  await page.screenshot({path:'artifacts/filters-bangumi-mobile.png'});
  assert.ok(await page.evaluate(()=>{const d=document.getElementById('bangumiDialog');return d.scrollWidth<=d.clientWidth&&document.getElementById('poolPanel').getBoundingClientRect().top>document.getElementById('bangumiUsers').getBoundingClientRect().bottom;}));
  // A room update can close the filter dialog under it; the import dialog goes too.
  await page.evaluate(()=>document.getElementById('filterDialog').close());await expect(page.locator('#bangumiDialog')).toBeHidden();
  // Shared controls must also apply successfully in local practice.
  await page.goto(base+'/?local');await page.waitForSelector('.card');await page.click('#filterButton');
  await page.fill('#minScore','6');await add('include','TV');await page.click('#applyFilters');
  await expect(page.locator('#filterDialog')).not.toBeVisible();await expect(page.locator('.card')).toHaveCount(25);
  await page.click('#filterButton');await expect(tag('include','TV')).toBeChecked();
  assert.deepEqual(errors,[]);
  console.log('Filter sliders, tag drafts, combined matching, room persistence, cancellation, mobile layout and local apply passed.');
 }finally{await browser.close();await worker.stop();}
})().catch(e=>{console.error(e);process.exit(1);});
