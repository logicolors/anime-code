const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/?local');
 await page.waitForSelector('.card');assert.equal(await page.locator('.card').count(),25);
 // Covers default to adaptive, which fits all five rows on a 1440×900 screen; full keeps the fixed 98px covers.
 await page.setViewportSize({width:1440,height:900});
 const boardFits=()=>page.evaluate(()=>document.querySelector('#board').lastElementChild.getBoundingClientRect().bottom<=innerHeight);
 const coverHeight=()=>page.evaluate(()=>document.querySelector('.card .cover').getBoundingClientRect().height);
 assert.equal(await page.locator('#coverMode').inputValue(),'adaptive');assert.equal(await boardFits(),true);
 await page.selectOption('#coverMode','full');assert.equal(await coverHeight(),98);
 await page.selectOption('#coverMode','none');assert.equal(await page.locator('.card .cover').first().isHidden(),true);assert.equal(await boardFits(),true);
 await page.reload();await page.waitForSelector('.card');assert.equal(await page.locator('#coverMode').inputValue(),'none');
 await page.selectOption('#coverMode','adaptive');
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
})().catch(e=>{console.error(e);process.exit(1);});
