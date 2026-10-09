import test from "node:test";
import assert from "node:assert/strict";
import {chromium} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const ui=path.join(root,"baseline/site16");
const events=Array.from({length:90},(_,i)=>({
 uid:"test-"+i,title:"Missa - Par. Sagrado Coração - Janaúba · compromisso "+i,
 start:new Date(Date.UTC(2026,9,9+Math.floor(i/3),13+i%3)).toISOString(),
 end:new Date(Date.UTC(2026,9,9+Math.floor(i/3),14+i%3)).toISOString(),
 all_day:false,source:"test",category:"Diocese",scope:"Diocese",
 location:"Janaúba",description:"Synthetic isolated test",cancelled:i===1,bishop_absent:i===0
}));
const liturgy=[{...events[0],uid:"liturgical",title:"Calendário Litúrgico · teste isolado",source:"liturgico",all_day:true,bishop_absent:false}];
const source={source_key:"test",label:"Teste isolado",enabled:true,last_status:200,last_synced_at:"2026-10-08T12:00:00Z",available:true};
const dashboard={health:{sources_total:1,sources_ok:1,future_events:90,oldest_sync_at:source.last_synced_at,
 sources:[source]},date_requests:{total:1,statuses:{recebida:1},recent:[{
 id:"00000000-0000-4000-8000-000000000004",created_at:"2026-10-08T12:00:00Z",parish_name:"Sagrado Coração",
 city:"Janaúba",requested_date:"2026-11-01",event_type:"Missa",requester_name:"Pessoa de teste",
 requester_role:"Secretaria",email:"isolado@example.invalid",phone:"000000000",community:"Teste",
 requested_time:"19:00",alternate_date:"2026-11-02",notes:"Observação sintética",status:"recebida"}]}};

test("Site16 regression: desktop/mobile, search, filters, admin details, manual sync, PDF margin boxes",async()=>{
 await mkdir(path.join(root,"test-results"),{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.AGENDA_CHROMIUM||path.join(root,".local-browser/chromium"),
  args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote","--single-process"],headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));let syncCalls=0;
 await page.clock.setFixedTime(new Date("2026-10-09T12:00:00Z"));
 await page.addInitScript(()=>{
  const auth={getSession:async()=>({data:{session:{access_token:"isolated"}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})};
  window.supabase={createClient:()=>({auth})};
  window.print=()=>{window.__printed=true;};
 });
 await page.route("**/*",async route=>{
  const url=new URL(route.request().url());
  if(url.host==="agenda-test.invalid"){
   let pathname=url.pathname==="/"?"index.html":url.pathname.slice(1);
   if(!/^[a-z0-9.-]+$/i.test(pathname)){await route.abort();return;}
   try {await route.fulfill({body:await readFile(path.join(ui,pathname)),
    contentType:pathname.endsWith(".js")?"application/javascript":pathname.endsWith(".css")?"text/css":"text/html"});}
   catch {await route.abort();}return;
  }
  if(url.pathname.endsWith("/vsc-agenda")){
   await route.fulfill({json:{events:url.searchParams.get("scope")==="liturgico"?liturgy:events,sources:[source],
    access:{display_name:"Administrador de teste",can_manage_users:true},generated_at:"2026-10-09T12:00:00Z"}});return;
  }
  if(url.pathname.endsWith("/vsc-agenda-admin-dashboard")){
   if(route.request().method()==="POST"){syncCalls++;await route.fulfill({json:{ok:true,message:"Sincronização concluída com sucesso."}});}
   else await route.fulfill({json:dashboard});return;
  }
  if(url.pathname.endsWith("/vsc-agenda-admin-users")){
   await route.fulfill({json:{users:[],access_requests:[],audit:[]}});return;
  }
  if(url.host==="cdn.jsdelivr.net"){await route.fulfill({body:"",contentType:"application/javascript"});return;}
  if(url.pathname.endsWith("vsc-favicon-agenda.png")){
   await route.fulfill({body:await readFile(path.join(ui,"vsc-favicon-agenda.png")),contentType:"image/png"});return;
  }
  await route.abort(); // No requests can reach Supabase/Google/production.
 });
 await page.goto("https://agenda-test.invalid");
 await page.waitForFunction(()=>document.querySelectorAll("#agenda-list .agenda-event").length>80);
 assert.equal(await page.locator("#agenda-list .agenda-event").count(),91);
 assert.equal(await page.locator("#agenda-list .agenda-bishop-note").count(),1);
 assert.equal(await page.locator("#agenda-list .is-cancelled").count(),1);
 await page.fill("#agenda-search","compromisso 88");await page.waitForTimeout(250);
 assert.equal(await page.locator("#agenda-list .agenda-event").count(),1);
 await page.fill("#agenda-search","");await page.waitForTimeout(250);
 await page.uncheck("#agenda-include-liturgy");assert.equal(await page.locator("#agenda-list .agenda-event").count(),90);
 await page.check("#agenda-include-liturgy");
 await page.uncheck("#filter-cancelled");assert.equal(await page.locator("#agenda-list .is-cancelled").count(),0);
 await page.check("#filter-cancelled");
 await page.click("#agenda-filter-button");await page.check('input[name="filter-period"][value="year"]');
 await page.selectOption("#filter-year","2026");await page.click("#agenda-apply-filters");
 assert.equal(await page.locator("#agenda-list .agenda-event").count(),91);
 await page.click('[data-view="month"]');assert.equal(await page.locator("#agenda-calendar").isVisible(),true);
 await page.click('[data-view="list"]');
 await page.click("#agenda-admin-open");await page.waitForSelector("#admin-date-body button");
 assert.equal(await page.locator("#admin-sources").textContent(),"1/1");
 await page.getByText("Ver detalhes",{exact:true}).click();
 assert.match(await page.locator(".agenda-admin-request-detail").textContent(),/Pessoa de teste/);
 await page.click("#agenda-admin-close");await page.click("#agenda-sync-now");
 await page.waitForFunction(()=>document.querySelector("#agenda-sync-now").disabled===false);
 assert.equal(syncCalls,1);
 await page.screenshot({path:path.join(root,"test-results/desktop.png"),fullPage:false});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const icon=await page.locator(".agenda-app-project-icon").boundingBox();
 assert.ok(icon.width<=32 && icon.height<=32);
 await page.screenshot({path:path.join(root,"test-results/mobile.png"),fullPage:false});
 await page.setViewportSize({width:1280,height:900});
 await page.click("#agenda-print-button");await page.waitForFunction(()=>window.__printed===true);
 const margins=await page.locator("#agenda-print-page-margins").textContent();
 assert.match(margins,/@top-left/);assert.match(margins,/agenda\.viasantacruz\.com\.br/);
 assert.match(margins,/@top-center/);assert.match(margins,/@top-right/);
 assert.match(margins,/@bottom-left/);assert.match(margins,/counter\(page\).*counter\(pages\)/s);
 assert.equal(await page.locator(".agenda-print-bishop-note").count(),1);
 assert.equal(await page.locator(".agenda-print-row .is-liturgical").count(),1);
 await page.emulateMedia({media:"print"});
 assert.equal(await page.locator("#agenda-print-foot").evaluate(el=>getComputedStyle(el).display),"none");
 assert.equal(await page.locator(".agenda-print-bishop-note").evaluate(el=>getComputedStyle(el).fontStyle),"italic");
 assert.equal(await page.locator(".agenda-print-row .is-liturgical").evaluate(el=>getComputedStyle(el).fontStyle),"italic");
 await page.pdf({path:path.join(root,"test-results/agenda-isolated.pdf"),preferCSSPageSize:true,printBackground:true});
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
