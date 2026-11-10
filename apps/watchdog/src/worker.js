// Fine Print Watchdog: audits ToS / privacy policies under a hard budget with pennypace.
import { createRunner, MUSE_EMBER } from "pennypace";
import pack from "../packs/policies.json";
import logoMark from "../../../assets/logo-mark.png"; // bundled as binary via [[rules]] in wrangler.toml
import favicon from "../favicon-32.png";

const TIERS = [
  { name: "full", maxInputChars: 6000, maxOutputTokens: 1200, reasoning: "minimal" },
  { name: "lite", maxInputChars: 1500, maxOutputTokens: 600, reasoning: "minimal" },
];

const SYSTEM = `You audit Terms of Service and privacy policies for ordinary users.
Reply with ONLY a JSON object, no prose, no code fences:
{"company": string, "risk_score": integer 0-100 (100 = worst for the user), "red_flags": [max 3 short strings], "data_sold_or_shared": boolean, "can_delete_account": boolean, "arbitration_clause": boolean, "one_line_verdict": string}`;

// Bundled fallbacks so the demo never breaks when a page can't be fetched.
const SAMPLES = [
  "We collect information you provide, device identifiers, location, browsing activity and inferences about your interests. We share personal information with advertising partners, data brokers and affiliates, and this may be considered a sale under some laws. We retain data for as long as necessary for business purposes. Any dispute will be resolved by binding individual arbitration and you waive the right to a class action or jury trial. You may request deletion of some data, but we may keep backups and records indefinitely. We may change these terms at any time without notice.",
  "We collect only the data needed to run the service: your email, account settings and basic usage logs. We do not sell your personal information. You can delete your account at any time from Settings and we remove personal data within 30 days. Disputes are handled in the courts of your home jurisdiction. We will notify you by email before material changes to this policy take effect.",
  "By using the service you grant us a perpetual, worldwide, sublicensable license to use, reproduce and create derivative works from your content, including for training machine learning models. We may share data with service providers and business partners. Account deletion deactivates your profile but content you posted may remain. Disputes must be brought in arbitration; class actions are waived. We may terminate your account at our sole discretion.",
];

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const byUrl = new Map(pack.map((p) => [p.url, p]));

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPolicy(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; FinePrintWatchdog/0.1)", accept: "text/html" },
      signal: ctl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (!r.ok) throw new Error("http " + r.status);
    const text = htmlToText((await r.text()).slice(0, 400000)).slice(0, 12000);
    if (text.length < 500) throw new Error("too short (JS-rendered?)");
    return { text, source: "live" };
  } catch {
    return { text: SAMPLES[hash(url) % SAMPLES.length], source: "sample" };
  }
}

function fakeAudit(url) {
  const h = hash(url);
  const host = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  const flags = [
    "Shares data with advertising partners",
    "Binding arbitration, class action waiver",
    "Broad license over your content",
    "Retains data after account deletion",
    "May change terms without notice",
    "Collects precise location",
  ];
  return {
    company: host[0].toUpperCase() + host.slice(1),
    risk_score: 10 + (h % 86),
    red_flags: [flags[h % 6], flags[(h >> 3) % 6], flags[(h >> 6) % 6]].filter((f, i, a) => a.indexOf(f) === i).slice(0, 1 + (h % 3)),
    data_sold_or_shared: h % 3 !== 0,
    can_delete_account: h % 4 !== 0,
    arbitration_clause: h % 2 === 0,
    one_line_verdict: "Simulated audit (dry run): no model was called.",
  };
}

const validate = (o) =>
  o && typeof o === "object" && typeof o.risk_score === "number" && Array.isArray(o.red_flags) && typeof o.one_line_verdict === "string";

function handleAudit(req, env) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => w.write(enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));

  const job = (async () => {
    let body;
    try {
      body = await req.json();
    } catch {
      await send("fatal", { error: "invalid JSON body" });
      return;
    }
    const urls = (Array.isArray(body.urls) ? body.urls : []).filter((u) => /^https?:\/\//.test(u)).slice(0, 200);
    const budget = Math.min(Math.max(Number(body.budgetUsd) || 0.01, 0.0001), 1);
    const dry = !!body.dry;
    if (!urls.length) return void (await send("fatal", { error: "no valid urls" }));
    if (!dry && !env.OPENROUTER_API_KEY) return void (await send("fatal", { error: "OPENROUTER_API_KEY is not set (use ?dry=1 or set the secret)" }));

    await send("start", { total: urls.length, budget, dry, model: MUSE_EMBER });

    // 1) fetch pages (skipped in dry mode: no subrequests at all)
    const pages = new Array(urls.length);
    if (dry) {
      urls.forEach((u, i) => (pages[i] = { text: SAMPLES[hash(u) % SAMPLES.length], source: "sample" }));
    } else {
      let next = 0;
      let done = 0;
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          while (next < urls.length) {
            const i = next++;
            pages[i] = await fetchPolicy(urls[i]);
            await send("fetching", { done: ++done, total: urls.length });
          }
        }),
      );
    }

    // 2) run the audits under the budget
    const runner = createRunner({
      apiKey: env.OPENROUTER_API_KEY,
      model: MUSE_EMBER,
      budgetUsd: budget,
      concurrency: 8,
      onBudget: "degrade",
      tiers: TIERS,
      priority: (u) => byUrl.get(u)?.priority ?? 5,
      dryRun: dry,
      referer: "https://github.com/pennypace/pennypace",
      appTitle: "Fine Print Watchdog",
    });
    const rows = new Array(urls.length);
    runner.on("result", ({ index, result }) => {
      const meta = byUrl.get(urls[index]);
      const data = result.data
        ? { ...result.data, red_flags: (result.data.red_flags || []).slice(0, 3) }
        : null;
      rows[index] = { url: urls[index], name: meta?.name, data, status: result.status };
      send("result", {
        index,
        url: urls[index],
        name: meta?.name || urls[index],
        source: pages[index].source,
        status: result.status,
        tier: result.tier,
        cost: result.cost,
        latencyMs: Math.round(result.latencyMs),
        error: result.error,
        data,
      });
    });
    runner.on("cost", (s) => send("stats", s));

    await runner.map(urls, (url, i) => ({
      system: SYSTEM,
      prompt: "Policy page: " + (byUrl.get(url)?.name || url) + " (" + url + ")\n\n" + pages[i].text,
      json: true,
      validate,
      fake: () => fakeAudit(url),
    }));

    const ranking = rows
      .filter((r) => r && r.data)
      .sort((a, b) => b.data.risk_score - a.data.risk_score)
      .slice(0, 10)
      .map((r) => ({ name: r.name || r.data.company, url: r.url, risk_score: r.data.risk_score, verdict: r.data.one_line_verdict }));
    await send("done", { report: runner.report(), ranking });
  })()
    .catch((e) => send("fatal", { error: String((e && e.message) || e) }))
    .finally(() => w.close());

  return { response: new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }), job };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/audit" && req.method === "POST") {
      const { response, job } = handleAudit(req, env);
      ctx.waitUntil(job);
      return response;
    }
    if (url.pathname === "/api/pack") return Response.json(pack);
    if (url.pathname === "/logo-mark.png" || url.pathname === "/favicon-32.png" || url.pathname === "/favicon.ico")
      return new Response(url.pathname === "/logo-mark.png" ? logoMark : favicon, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
};

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fine Print Watchdog</title>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<style>
:root{--bg:#0b0f17;--panel:#141b28;--line:#25304a;--text:#eef2fa;--mute:#93a0ba;--good:#2ecc71;--warn:#f5b73b;--bad:#ff5d5d;--full:#4da3ff;--lite:#b78bff;--skip:#6b7690}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:18px/1.45 system-ui,Segoe UI,sans-serif}
header,main,footer{max-width:1200px;margin:0 auto;padding:0 16px}
h1{font-size:clamp(28px,5vw,52px);line-height:1.1;margin:28px 0 6px}
.brand{display:flex;align-items:center;gap:12px;margin-top:20px;font-weight:800;font-size:1.3rem}.brand img{border-radius:12px}
.sub{color:var(--mute);margin:0 0 18px;font-size:1.05rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px 20px;cursor:pointer;background:#2a3550;color:var(--text)}
button.primary{background:var(--full);color:#04101f}button:disabled{opacity:.5;cursor:default}
textarea{width:100%;height:90px;background:#0e1420;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px;font:13px monospace}
input[type=range]{flex:1;min-width:220px;height:32px;accent-color:var(--full)}
.big{font-size:1.6rem;font-weight:800;min-width:110px}
#bar{position:sticky;top:0;z-index:5;background:#0b0f17ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:10px 0}
#stats{display:flex;gap:6px 22px;flex-wrap:wrap;font-weight:700;font-size:1.05rem}
#stats span b{color:var(--full)}
#prog{height:10px;background:#1b2436;border-radius:6px;margin-top:8px;overflow:hidden}#progf{height:100%;width:0;background:linear-gradient(90deg,var(--good),var(--warn),var(--bad));transition:width .2s}
#cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-left:6px solid var(--skip);border-radius:12px;padding:12px 14px}
.card.low{border-left-color:var(--good)}.card.mid{border-left-color:var(--warn)}.card.high{border-left-color:var(--bad)}
.card h3{margin:0 0 6px;font-size:1.05rem;display:flex;justify-content:space-between;gap:8px;align-items:center}
.badge{font-size:.72rem;font-weight:800;padding:3px 9px;border-radius:99px;color:#04101f}
.b-full{background:var(--full)}.b-lite{background:var(--lite)}.b-skipped{background:var(--skip);color:#fff}.b-error{background:var(--bad)}
.score{font-size:1.9rem;font-weight:900}.low .score{color:var(--good)}.mid .score{color:var(--warn)}.high .score{color:var(--bad)}
.card ul{margin:6px 0;padding-left:20px;font-size:.92rem}.verdict{font-size:.92rem;color:var(--mute)}.meta{font-size:.78rem;color:var(--mute);margin-top:6px}
.card.skipped{opacity:.55;padding:8px 14px}
#final h2{margin:6px 0 10px}ol{padding-left:24px}ol li{margin:6px 0}
pre{background:#0e1420;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;font-size:.85rem}
footer{color:var(--mute);text-align:center;padding:30px 16px 40px}
.dry{display:inline-block;background:var(--warn);color:#000;font-weight:800;padding:2px 10px;border-radius:8px;font-size:.8rem;vertical-align:middle}
</style></head><body>
<header>
<div class="brand"><img src="/logo-mark.png" alt="pennypace" width="64" height="64"><span>pennypace</span></div>
<h1>Agents die when the money runs out. This one adapts.</h1>
<p class="sub">Fine Print Watchdog audits Terms of Service &amp; privacy policies under a hard dollar budget. Shrink the budget and watch it downgrade, then triage, instead of crashing. <span id="drytag" class="dry" hidden>DRY RUN: no API calls</span></p>
<div class="panel">
 <div class="row"><button id="load">Load 100 demo URLs</button><span id="count" class="sub" style="margin:0">0 URLs</span></div>
 <textarea id="urls" placeholder="One URL per line, or click Load 100 demo URLs"></textarea>
 <div class="row" style="margin-top:12px"><span>Budget</span><input id="slider" type="range" min="0" max="100" value="50"><span id="bval" class="big"></span><button id="run" class="primary">Run audit</button></div>
</div>
</header>
<div id="bar"><div style="max-width:1200px;margin:0 auto;padding:0 16px">
 <div id="stats"><span>$<b id="s-spent">0</b> / $<b id="s-budget">0</b></span><span>audited <b id="s-aud">0</b></span><span>coverage <b id="s-cov">0%</b></span><span>$/audit <b id="s-per">-</b></span><span>tasks per $1 <b id="s-tpd">-</b></span><span>FULL <b id="s-full">0</b></span><span>LITE <b id="s-lite">0</b></span><span>SKIPPED <b id="s-skip">0</b></span><span>elapsed <b id="s-el">0.0s</b></span></div>
 <div id="prog"><div id="progf"></div></div></div></div>
<main>
 <p id="status" class="sub" style="margin-top:14px"></p>
 <div id="cards"></div>
 <div id="final" class="panel" hidden><h2>Most risky policies</h2><ol id="rank"></ol><h2>Final report</h2><pre id="report"></pre></div>
</main>
<footer>Built on Meta Muse Ember via OpenRouter | powered by pennypace</footer>
<script>
var $=function(id){return document.getElementById(id)};
var dry=new URLSearchParams(location.search).get("dry")==="1";
if(dry)$("drytag").hidden=false;
function budget(){return Math.pow(10,-3+3*$("slider").value/100)}
function fmt(n){return n>=0.1?n.toFixed(2):n>=0.01?n.toFixed(3):n.toFixed(4)}
function upd(){$("bval").textContent="$"+fmt(budget())}
$("slider").oninput=upd;upd();
function count(){var n=$("urls").value.split("\n").filter(function(l){return l.trim()}).length;$("count").textContent=n+" URLs"}
$("urls").oninput=count;
$("load").onclick=function(){return fetch("/api/pack").then(function(r){return r.json()}).then(function(p){$("urls").value=p.map(function(x){return x.url}).join("\n");count()})};
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
var t0=0,timer=null;
function stats(s){
 $("s-spent").textContent=s.spent.toFixed(5);$("s-budget").textContent=s.budget.toFixed(4);
 var aud=Object.keys(s.tierCounts).reduce(function(a,k){return k==="skipped"?a:a+s.tierCounts[k]},0);
 $("s-aud").textContent=aud;$("s-cov").textContent=s.coverage.toFixed(0)+"%";
 $("s-per").textContent=s.calls?"$"+(s.spent/s.calls).toFixed(5):"-";
 $("s-tpd").textContent=s.tasksPerDollar?Math.round(s.tasksPerDollar):"-";
 $("s-full").textContent=s.tierCounts.full||0;$("s-lite").textContent=s.tierCounts.lite||0;$("s-skip").textContent=s.tierCounts.skipped||0;
 $("progf").style.width=Math.min(100,100*s.spent/s.budget)+"%";
}
function card(r){
 var d=r.data,div=document.createElement("div");
 if(r.status==="skipped:budget"){div.className="card skipped";div.innerHTML="<h3><span>"+esc(r.name)+"</span><span class='badge b-skipped'>SKIPPED</span></h3><div class='meta'>out of budget</div>";return div}
 if(!d){div.className="card";div.innerHTML="<h3><span>"+esc(r.name)+"</span><span class='badge b-error'>"+esc(r.tier?r.tier.toUpperCase():"ERROR")+"</span></h3><div class='verdict'>"+esc(r.error||"error")+"</div>";return div}
 var lvl=d.risk_score>=65?"high":d.risk_score>=35?"mid":"low";
 div.className="card "+lvl;
 var flags=(d.red_flags||[]).map(function(f){return"<li>"+esc(f)+"</li>"}).join("");
 var tags=[d.data_sold_or_shared?"data shared/sold":"no data sale",d.can_delete_account?"can delete":"no clear delete",d.arbitration_clause?"arbitration":"no arbitration"].join(" | ");
 div.innerHTML="<h3><span>"+esc(r.name)+"</span><span class='badge b-"+r.tier+"'>"+r.tier.toUpperCase()+"</span></h3><div class='score'>"+Math.round(d.risk_score)+"<small style='font-size:.9rem;color:var(--mute)'> /100 risk</small></div><ul>"+flags+"</ul><div class='verdict'>"+esc(d.one_line_verdict)+"</div><div class='meta'>"+tags+"<br>$"+r.cost.toFixed(5)+" | "+r.latencyMs+"ms | "+r.source+"</div>";
 return div;
}
function on(ev,data){
 if(ev==="start"){$("status").textContent="Auditing "+data.total+" policies with "+data.model+(data.dry?" (dry run)":"")+"..."}
 else if(ev==="fetching"){$("status").textContent="Fetching pages "+data.done+"/"+data.total+"..."}
 else if(ev==="result"){$("status").textContent="Auditing...";$("cards").appendChild(card(data))}
 else if(ev==="stats"){stats(data)}
 else if(ev==="done"){clearInterval(timer);$("status").textContent="Done.";stats(data.report);
  $("rank").innerHTML=data.ranking.map(function(r){return"<li><b>"+Math.round(r.risk_score)+"</b> "+esc(r.name)+" - "+esc(r.verdict)+"</li>"}).join("");
  $("report").textContent=JSON.stringify(data.report,null,2);$("final").hidden=false;$("run").disabled=false}
 else if(ev==="fatal"){clearInterval(timer);$("status").textContent="Error: "+data.error;$("run").disabled=false}
}
$("run").onclick=function(){
 var go=function(){
  var urls=$("urls").value.split("\n").map(function(s){return s.trim()}).filter(Boolean);
  $("cards").innerHTML="";$("final").hidden=true;$("run").disabled=true;$("status").textContent="Starting...";
  t0=Date.now();clearInterval(timer);timer=setInterval(function(){$("s-el").textContent=((Date.now()-t0)/1000).toFixed(1)+"s"},100);
  fetch("/api/audit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({urls:urls,budgetUsd:budget(),dry:dry})}).then(function(res){
   var rd=res.body.getReader(),dec=new TextDecoder(),buf="";
   function pump(){return rd.read().then(function(x){
    if(x.done){clearInterval(timer);$("run").disabled=false;return}
    buf+=dec.decode(x.value,{stream:true});var parts=buf.split("\n\n");buf=parts.pop();
    parts.forEach(function(p){var m=p.match(/^event: (.*)\ndata: ([\s\S]*)$/);if(m)on(m[1],JSON.parse(m[2]))});
    return pump()})}
   return pump()}).catch(function(e){on("fatal",{error:String(e)})});
 };
 if(!$("urls").value.trim())$("load").onclick().then(go);else go();
};
</script></body></html>`;
