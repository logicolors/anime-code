const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {startWorker}=require('./worker-server.cjs');
(async()=>{
 const worker=await startWorker();
 try{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(worker.base+'/?local');
 await page.waitForSelector('.card');assert.equal(await page.locator('.card').count(),25);
 // Covers default to adaptive, which fits all five rows on a 1440×900 screen; full keeps the fixed 98px covers and small a 64px strip.
 await page.setViewportSize({width:1440,height:900});
 const boardFits=()=>page.evaluate(()=>document.querySelector('#board').lastElementChild.getBoundingClientRect().bottom<=innerHeight);
 const coverHeight=()=>page.evaluate(()=>document.querySelector('.card .cover').getBoundingClientRect().height);
 assert.equal(await page.locator('#coverMode').inputValue(),'adaptive');assert.equal(await boardFits(),true);
 await page.selectOption('#coverMode','full');assert.equal(await coverHeight(),98);
 await page.selectOption('#coverMode','small');assert.equal(await coverHeight(),64);assert.equal(await boardFits(),true);
 await page.selectOption('#coverMode','none');assert.equal(await page.locator('.card .cover').first().isHidden(),true);assert.equal(await boardFits(),true);
 await page.reload();await page.waitForSelector('.card');assert.equal(await page.locator('#coverMode').inputValue(),'none');
 await page.selectOption('#coverMode','adaptive');
 // Card titles default to medium; large titles get a taller name bar, the adaptive board still fits, and the choice persists.
 const nameFont=()=>page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('#board .card-name')).fontSize));
 const twoLinesFit=()=>page.evaluate(()=>[...document.querySelectorAll('#board .card-name span')].every(span=>span.scrollHeight<=span.parentElement.clientHeight));
 assert.equal(await page.locator('#nameSize').inputValue(),'medium');assert.equal(await nameFont(),11);
 await page.selectOption('#nameSize','small');assert.equal(await nameFont(),10);
 await page.selectOption('#nameSize','large');assert.equal(await nameFont(),13);assert.equal(await twoLinesFit(),true);assert.equal(await boardFits(),true);
 await page.reload();await page.waitForSelector('.card');assert.equal(await page.locator('#nameSize').inputValue(),'large');assert.equal(await nameFont(),13);
 await page.selectOption('#nameSize','medium');
 // Team colours default to filled cards; the text mode persists and only restyles the game board.
 const hasColorText=()=>page.evaluate(()=>document.body.classList.contains('color-text'));
 assert.equal(await page.locator('#colorMode').inputValue(),'fill');assert.equal(await hasColorText(),false);
 await page.selectOption('#colorMode','text');assert.equal(await hasColorText(),true);
 await page.reload();await page.waitForSelector('.card');assert.equal(await page.locator('#colorMode').inputValue(),'text');assert.equal(await hasColorText(),true);
 await page.selectOption('#colorMode','fill');assert.equal(await hasColorText(),false);
 await page.setViewportSize({width:1440,height:1100});
 assert.match(await page.locator('footer').innerText(),/数据来源：Bangumi[\s\S]*灵感来源：Codenames[\s\S]*数据更新：\d\d\.\d\d\.\d\d/);
 assert.equal(await page.locator('.known').count(),0);
 assert.equal(await page.locator('#detailPanel').isHidden(),true);
 await page.locator('.card').first().click();assert.equal(await page.locator('#detailPanel').isVisible(),true);assert.match(await page.locator('#detailName').innerText(),/\S/);
 await page.locator('.card').first().click();assert.equal(await page.locator('#detailPanel').isHidden(),true);
 await page.click('#captainView');assert.equal(await page.locator('#privacyDialog').isVisible(),true);
 await page.click('#unlockMap');assert.equal(await page.locator('.known').count(),25);assert.equal(await page.locator('.revealed').count(),0);
 const red=await page.locator('.card.red').first().getAttribute('data-index');
 await page.click('#guesserView');assert.equal(await page.locator('.known').count(),0);
 await page.click('#captainView');await page.click('#unlockMap');await page.fill('#clueInput','时间');await page.fill('#numberInput','3');await page.click('#clueForm button');
 assert.equal(await page.locator('#guesserView').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.known').count(),0);
 await page.locator('.card').nth(Number(red)).click();assert.equal(await page.locator('.revealed').count(),0);await page.click('#confirmGuess');assert.equal(await page.locator('.revealed').count(),1);assert.equal(await page.locator('#redRemaining').innerText(),'8');
 await page.click('#endTurn');assert.match(await page.locator('#turnTitle').innerText(),/蓝队/);
 // The action log replays the round: red's clue with what it found, then blue's captain still on the clue.
 assert.equal(await page.locator('#logPage').innerText(),'第 1 / 1 轮');
 assert.equal(await page.locator('#logBody .log-turn').count(),2);
 assert.match(await page.locator('#logBody .log-turn.red .log-clue').innerText(),/时间\s*3\s*猜中 1 · 差 2/);
 assert.equal(await page.locator('#logBody .log-turn.red .log-flip.hit').count(),1);
 assert.match(await page.locator('#logBody .log-turn.blue').innerText(),/等待队长给出提示/);
 await page.click('#logToggle');assert.equal(await page.locator('#logBody').isHidden(),true);assert.equal(await page.locator('#logToggle').getAttribute('aria-expanded'),'false');
 await page.reload();await page.waitForSelector('#board .card');assert.equal(await page.locator('.log-panel').isHidden(),true,'a fresh deal has no log yet');
 assert.equal(await page.evaluate(()=>localStorage.getItem('anicode-log-open')),'false','the fold is remembered');
 await page.evaluate(()=>localStorage.removeItem('anicode-log-open'));await page.reload();await page.waitForSelector('#board .card');
 await page.click('#filterButton');await page.fill('#minVotes','999999');assert.equal(await page.locator('#applyFilters').isDisabled(),true);await page.click('#filterDialog [data-close]');
 await page.click('#newButton');await page.click('#restartConfirm');
 // Allow actual network covers to settle before visual review.
 await page.waitForTimeout(6000);
 fs.mkdirSync('artifacts',{recursive:true});
 await page.screenshot({path:'artifacts/desktop.png',fullPage:true});
 console.log('Covers loaded:',await page.locator('.cover img').evaluateAll(imgs=>imgs.filter(i=>i.complete&&i.naturalWidth>0).length),'/ 25');
 await page.click('#captainView');await page.click('#unlockMap');await page.screenshot({path:'artifacts/captain.png',fullPage:true});
 await page.click('#guesserView');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 // File fallback should remain usable even when remote cover servers cannot respond.
 await page.route(/https?:\/\//,route=>route.abort());
 await page.goto('file:///'+path.resolve(__dirname,'../index.html').split(path.sep).join('/'));await page.waitForSelector('.card');assert.equal(await page.locator('.card').count(),25);
 assert.deepEqual(errors,[]);await browser.close();console.log('Browser flows, mobile overflow, and file:// fallback passed.');
 }finally{await worker.stop();}
})().catch(e=>{console.error(e);process.exit(1);});
