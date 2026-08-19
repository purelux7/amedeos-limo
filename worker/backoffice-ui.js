/* ============================================================
   Amedeo's back office.

   A single self-contained document: no build step, no framework, no
   CDN. It is served by the Worker that owns the data, so there is
   nothing to deploy separately and nothing that can go stale.

   Six sections — Dashboard, Calendar, Rides, Customers, Invoices,
   Settings — behind a sidebar on a desktop and a tab bar on a phone.

   NOTE FOR ANYONE EDITING: this whole file is a JS template literal.
   Every backslash inside the page's own JavaScript is eaten once
   before the browser sees it, so regexes need \\d, not \d. A ZIP
   check shipped as /^d{5}$/ once and rejected every real ZIP; the
   rendered-pages test suite exists to catch exactly that.
   ============================================================ */

export const BACKOFFICE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<meta name="theme-color" content="#14171c"/>
<title>Amedeo's — Back Office</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root{
  --ink:#14171c; --body:#5b6470; --muted:#8a929d; --faint:#b3b9c2;
  --bg:#f6f7f9; --panel:#ffffff; --line:#e6e8ec; --line2:#d3d7dd;
  --graphite:#14171c; --graphite2:#232830;
  --gold:#8a6d2f; --gold2:#c8a961;
  --metal:linear-gradient(135deg,#e0c894 0%,#a8873f 34%,#8a6d2f 58%,#d6bd84 100%);
  --ok:#1f7a4d; --ok-bg:#e9f6ee; --warn:#9a6b12; --warn-bg:#fdf3e2;
  --bad:#b03a3a; --bad-bg:#f7ecec; --info:#3d6b8f; --info-bg:#ecf2f7;
  --sans:Inter,system-ui,-apple-system,sans-serif;
  --serif:"Cormorant Garamond",Georgia,serif;
  --rail:238px;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--body);font:400 14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
h1,h2,h3{margin:0;color:var(--ink)}
a{color:inherit;text-decoration:none}
button,input,select,textarea{font:inherit}
input,select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line2);border-radius:2px;
  background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--gold)}
label{display:block;font-size:.63rem;text-transform:uppercase;letter-spacing:.16em;
  color:var(--muted);font-weight:600;margin-bottom:6px}
.field{margin-bottom:14px}

/* ---------- buttons ---------- */
.btn{border:1px solid transparent;border-radius:2px;padding:12px 20px;cursor:pointer;
  font:600 .7rem/1 var(--sans);text-transform:uppercase;letter-spacing:.14em;
  background:var(--metal);color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn:hover{filter:brightness(1.06)}
.btn[disabled]{opacity:.5;cursor:default;filter:none}
.btn.ghost{background:#fff;color:var(--ink);border-color:var(--line2)}
.btn.ghost:hover{border-color:var(--gold);color:var(--gold);filter:none}
.btn.danger{background:#fff;color:var(--bad);border-color:#e6cccc}
.btn.sm{padding:9px 14px;font-size:.62rem}
.btn.block{width:100%}

/* ---------- login ---------- */
#login{position:fixed;inset:0;background:var(--graphite);display:flex;align-items:center;
  justify-content:center;padding:24px;z-index:60}
.login-card{background:#fff;padding:38px 32px;width:100%;max-width:360px;text-align:center;
  box-shadow:0 40px 80px -40px rgba(0,0,0,.6)}
.login-card b{font:600 1.9rem/1 var(--serif);color:var(--ink);display:block}
.login-card .sub{font-size:.55rem;letter-spacing:.32em;text-transform:uppercase;color:var(--gold);
  font-weight:600;margin:7px 0 26px}
.err{color:var(--bad);font-size:.84rem;margin-top:11px;min-height:1.1em}

/* ---------- shell ---------- */
#app{display:none}
.rail{position:fixed;left:0;top:0;bottom:0;width:var(--rail);background:var(--graphite);
  padding:24px 0;display:flex;flex-direction:column;z-index:30}
.rail .brand{padding:0 24px 26px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:16px}
.rail .brand b{font:600 1.45rem/1 var(--serif);color:#fff;display:block}
.rail .brand span{font-size:.5rem;letter-spacing:.3em;text-transform:uppercase;color:var(--gold2);
  font-weight:600;display:block;margin-top:6px}
.rail nav{flex:1;display:flex;flex-direction:column;gap:2px;padding:0 12px}
.rail nav button{display:flex;align-items:center;gap:12px;width:100%;background:none;border:0;
  color:rgba(255,255,255,.62);padding:11px 12px;cursor:pointer;text-align:left;
  font-size:.82rem;font-weight:500;border-radius:2px}
.rail nav button svg{width:17px;height:17px;flex:none;stroke:currentColor;fill:none;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round}
.rail nav button:hover{color:#fff;background:rgba(255,255,255,.05)}
.rail nav button.on{color:#fff;background:rgba(200,169,97,.14);box-shadow:inset 2px 0 0 var(--gold2)}
.rail .foot{padding:16px 22px 0;border-top:1px solid rgba(255,255,255,.08)}
.rail .foot button{background:none;border:0;color:rgba(255,255,255,.45);cursor:pointer;
  font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;padding:0}
.rail .foot button:hover{color:#fff}
main{margin-left:var(--rail);padding:30px 34px 90px;max-width:1500px}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:26px;flex-wrap:wrap}
.head h1{font:500 2.1rem/1.1 var(--serif)}
.head .eyebrow{font-size:.6rem;letter-spacing:.28em;text-transform:uppercase;color:var(--gold);
  font-weight:600;margin-bottom:8px}
.tabbar{display:none}

/* ---------- panels ---------- */
.panel{background:var(--panel);border:1px solid var(--line);margin-bottom:18px}
.panel .ph{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;
  align-items:center;justify-content:space-between;gap:12px}
.panel .ph h3{font-size:.68rem;text-transform:uppercase;letter-spacing:.18em;font-weight:600;color:var(--ink)}
.panel .pb{padding:20px}
.panel .pb.flush{padding:0}

/* ---------- KPI tiles ---------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:var(--panel);border:1px solid var(--line);padding:20px}
.kpi .k{font-size:.6rem;text-transform:uppercase;letter-spacing:.18em;color:var(--muted);font-weight:600}
.kpi .v{font:500 2.15rem/1 var(--serif);color:var(--ink);margin:12px 0 4px}
.kpi .s{font-size:.76rem;color:var(--muted)}
.kpi.gold{border-top:2px solid var(--gold)}

/* ---------- tables / rows ---------- */
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 20px;
  border-bottom:1px solid var(--line);cursor:pointer}
.row:last-child{border-bottom:0}
.row:hover{background:#fafbfc}
.row .t{font-weight:600;color:var(--ink)}
.row .m{font-size:.78rem;color:var(--muted);margin-top:2px}
.row .n{font:500 1.15rem/1 var(--serif);color:var(--ink);white-space:nowrap}
.empty{padding:44px 20px;text-align:center;color:var(--muted)}
.pill{display:inline-block;font-size:.56rem;text-transform:uppercase;letter-spacing:.14em;
  font-weight:700;padding:3px 7px;border-radius:2px;margin-left:8px;vertical-align:middle}
.pill.draft{background:#eef0f3;color:#5b6470}
.pill.sent,.pill.new{background:var(--warn-bg);color:var(--warn)}
.pill.paid,.pill.confirmed,.pill.charged{background:var(--ok-bg);color:var(--ok)}
.pill.void,.pill.canceled{background:var(--bad-bg);color:var(--bad)}
.pill.done{background:var(--info-bg);color:var(--info)}
.searchbar{display:flex;gap:10px;margin-bottom:16px}
.searchbar input{max-width:340px}

/* ---------- calendar ---------- */
.calbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.calbar .title{font:500 1.5rem/1 var(--serif);color:var(--ink);min-width:220px}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:2px;overflow:hidden}
.seg button{background:#fff;border:0;padding:9px 15px;cursor:pointer;font-size:.66rem;
  text-transform:uppercase;letter-spacing:.13em;font-weight:600;color:var(--body)}
.seg button+button{border-left:1px solid var(--line2)}
.seg button.on{background:var(--graphite);color:#fff}
.nav-btn{border:1px solid var(--line2);background:#fff;width:36px;height:36px;cursor:pointer;
  font-size:1.1rem;line-height:1;color:var(--ink);border-radius:2px}

.mgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line)}
.mgrid .dow{background:#fff;text-align:center;padding:9px 0;font-size:.56rem;font-weight:700;
  letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.mcell{background:#fff;min-height:116px;padding:7px 7px 9px;cursor:pointer;position:relative}
.mcell.out{background:#fafbfc}
.mcell:hover{background:#f7f8fa}
.mcell .d{font-size:.78rem;font-weight:600;color:var(--ink)}
.mcell.out .d{color:var(--faint);font-weight:400}
.mcell.today .d{background:var(--metal);color:#fff;width:23px;height:23px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;font-size:.72rem}
.ev{margin-top:4px;padding:3px 6px;border-radius:2px;font-size:.68rem;line-height:1.35;
  background:var(--graphite);color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev.off{background:#eceef2;color:var(--body)}
.ev.due{background:var(--info-bg);color:var(--info);border-left:2px solid var(--info)}
.ev.unpaid{background:var(--warn-bg);color:var(--warn)}
.mcell .more{font-size:.6rem;color:var(--muted);margin-top:3px}

.tgrid{display:grid;background:var(--line);border:1px solid var(--line);gap:1px;
  grid-template-columns:62px repeat(var(--cols),1fr)}
.tgrid .corner,.tgrid .colhead{background:#fff;padding:9px 6px;text-align:center;font-size:.62rem;
  font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.tgrid .colhead b{display:block;font:500 1.15rem/1.2 var(--serif);color:var(--ink);
  letter-spacing:0;text-transform:none;margin-top:3px}
.tgrid .colhead.today b{color:var(--gold)}
.tgrid .hourlab{background:#fff;font-size:.6rem;color:var(--muted);text-align:right;
  padding:2px 8px 0 0;height:46px}
.tcol{background:#fff;position:relative;height:46px;cursor:pointer}
.tcol:hover{background:#fafbfc}
.tev{position:absolute;left:3px;right:3px;background:var(--graphite);color:#fff;border-radius:2px;
  padding:4px 6px;font-size:.66rem;line-height:1.3;overflow:hidden;z-index:2;cursor:pointer;
  border-left:3px solid var(--gold2)}
.tev.off{background:repeating-linear-gradient(45deg,#eceef2,#eceef2 6px,#e4e7ec 6px,#e4e7ec 12px);
  color:var(--body);border-left-color:var(--line2)}
.tev b{display:block;font-weight:600}

/* ---------- drawer ---------- */
#drawer{position:fixed;inset:0;background:rgba(20,23,28,.45);display:none;z-index:50;
  justify-content:flex-end}
#drawer .sheet{background:#fff;width:100%;max-width:520px;height:100%;overflow:auto;padding:26px 26px 60px}
#drawer h2{font:500 1.7rem/1.15 var(--serif);margin-bottom:4px}
#drawer .sub{color:var(--muted);font-size:.86rem;margin-bottom:20px}
.dl{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--line);font-size:.9rem}
.dl:last-of-type{border-bottom:0}
.dl span:first-child{color:var(--muted)}
.dl span:last-child{color:var(--ink);text-align:right}
.sechead{font-size:.6rem;text-transform:uppercase;letter-spacing:.2em;color:var(--gold);
  font-weight:600;margin:26px 0 10px}
.acts2{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:16px}

.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--graphite);
  color:#fff;padding:13px 22px;font-size:.85rem;display:none;z-index:70;border-radius:2px}
.linkbox{display:flex;gap:8px;margin-top:10px}
.linkbox input{font-size:.74rem;background:#f6f7f9}
.li{display:grid;grid-template-columns:1fr 56px 84px 32px;gap:7px;margin-bottom:8px;align-items:center}
.li .x{border:0;background:none;color:var(--muted);font-size:1.15rem;cursor:pointer}
.setgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.spark{display:flex;align-items:flex-end;gap:4px;height:60px;margin-top:14px}
.spark i{flex:1;background:var(--metal);opacity:.85;min-height:2px;border-radius:1px}
.spark i.zero{background:var(--line2)}

@media (max-width:900px){
  .rail{position:static;width:auto;height:auto;flex-direction:row;align-items:center;
    padding:12px 16px;gap:14px}
  .rail .brand{padding:0;border:0;margin:0;flex:1}
  .rail .brand b{font-size:1.15rem}
  .rail nav{display:none}
  .rail .foot{padding:0;border:0}
  main{margin-left:0;padding:18px 14px 96px}
  .head h1{font-size:1.7rem}
  .tabbar{display:flex;position:fixed;left:0;right:0;bottom:0;background:#fff;
    border-top:1px solid var(--line);z-index:40}
  .tabbar button{flex:1;background:none;border:0;padding:9px 2px 11px;color:var(--muted);
    font-size:.56rem;letter-spacing:.08em;text-transform:uppercase;font-weight:600;cursor:pointer}
  .tabbar button svg{display:block;margin:0 auto 4px;width:19px;height:19px;stroke:currentColor;
    fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .tabbar button.on{color:var(--ink)}
  .mcell{min-height:74px}
  .ev{font-size:.6rem}
  #drawer .sheet{max-width:none}
  .li{grid-template-columns:1fr 46px 72px 28px}
}
</style>
</head>
<body>

<div id="login">
  <div class="login-card">
    <b>Amedeo's</b>
    <div class="sub">Back Office</div>
    <input type="password" id="pw" placeholder="Password" autocomplete="current-password"/>
    <button class="btn block" id="loginBtn" style="margin-top:14px">Sign in</button>
    <p class="err" id="loginErr"></p>
  </div>
</div>

<div id="app">
  <aside class="rail">
    <div class="brand"><b>Amedeo's</b><span>Back Office</span></div>
    <nav id="nav"></nav>
    <div class="foot"><button id="signout">Sign out</button></div>
  </aside>

  <main>
    <div class="head">
      <div><div class="eyebrow" id="crumb">Overview</div><h1 id="title">Dashboard</h1></div>
      <div id="headActions"></div>
    </div>
    <div id="view"></div>
  </main>

  <div class="tabbar" id="tabbar"></div>
</div>

<div id="drawer"><div class="sheet" id="sheet"></div></div>
<div class="toast" id="toast"></div>

<script>
(function(){
"use strict";

/* ---------- tiny helpers ---------- */
function gid(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/[<>&"]/g,function(c){
  return {"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]; }); }
function money(n){ return (Math.round((Number(n)||0)*100)/100).toFixed(2); }
function money0(n){ return "$" + Math.round(Number(n)||0).toLocaleString(); }

function api(path, opts){
  opts = opts || {};
  opts.credentials = "include";
  if (opts.body){ opts.headers = {"Content-Type":"application/json"}; opts.body = JSON.stringify(opts.body); }
  return fetch(path, opts).then(function(r){
    return r.json().then(function(j){ return {ok:r.ok, status:r.status, data:j}; })
                   .catch(function(){ return {ok:r.ok, status:r.status, data:{}}; });
  });
}

var toastT = null;
function toast(msg){
  var t = gid("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastT); toastT = setTimeout(function(){ t.style.display = "none"; }, 2800);
}

/* All display is Florida local, regardless of where the browser is. */
var TZ = "America/New_York";
function ymd(ms){
  var f = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  return f.format(new Date(ms));
}
function todayStr(){ return ymd(Date.now()); }
function prettyDate(s){
  if (!s) return "";
  var p = s.split("-");
  var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}
function prettyTime(t){
  if (!t) return "";
  var p = t.split(":"); var h = Number(p[0]); var ap = h >= 12 ? "pm" : "am";
  var hh = h % 12; if (hh === 0) hh = 12;
  return hh + (p[1] === "00" ? "" : ":" + p[1]) + ap;
}

/* ---------- icons ---------- */
var IC = {
  dash: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="8"/><rect x="13.5" y="3.5" width="7" height="5"/><rect x="3.5" y="15.5" width="7" height="5"/><rect x="13.5" y="12.5" width="7" height="8"/></svg>',
  cal:  '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></svg>',
  ride: '<svg viewBox="0 0 24 24"><path d="M4.5 12l1.6-4.6A2 2 0 0 1 8 6h8a2 2 0 0 1 1.9 1.4L19.5 12"/><rect x="3" y="12" width="18" height="5.5" rx="1"/><path d="M6.5 17.5v2M17.5 17.5v2"/></svg>',
  cust: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-3.6 3.4-5.6 7.5-5.6s7.5 2 7.5 5.6"/></svg>',
  inv:  '<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8.5h6M9 12.5h6"/></svg>',
  set:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.7 5.3l-1.7 1.7M7 17l-1.7 1.7M18.7 18.7L17 17M7 7L5.3 5.3"/></svg>'
};

var SECTIONS = [
  {id:"dashboard", label:"Dashboard", crumb:"Overview",   icon:IC.dash},
  {id:"calendar",  label:"Calendar",  crumb:"Schedule",   icon:IC.cal},
  {id:"rides",     label:"Rides",     crumb:"Bookings",   icon:IC.ride},
  {id:"customers", label:"Customers", crumb:"Relationships", icon:IC.cust},
  {id:"invoices",  label:"Invoices",  crumb:"Billing",    icon:IC.inv},
  {id:"settings",  label:"Settings",  crumb:"Configuration", icon:IC.set}
];

var S = { view:"dashboard", stats:null, bookings:[], customers:[], invoices:[],
          settings:null, cal:{mode:"month", anchor:null, data:null} };

/* ---------- shell ---------- */
function paintNav(){
  gid("nav").innerHTML = SECTIONS.map(function(s){
    return '<button data-v="' + s.id + '" class="' + (S.view===s.id?"on":"") + '">' +
      s.icon + '<span>' + s.label + '</span></button>';
  }).join("");
  gid("tabbar").innerHTML = SECTIONS.map(function(s){
    return '<button data-v="' + s.id + '" class="' + (S.view===s.id?"on":"") + '">' +
      s.icon + s.label + '</button>';
  }).join("");
  var bs = document.querySelectorAll("[data-v]");
  for (var i=0;i<bs.length;i++){
    (function(b){ b.onclick = function(){ go(b.getAttribute("data-v")); }; })(bs[i]);
  }
}

function go(v){
  S.view = v;
  var sec = SECTIONS.filter(function(s){ return s.id === v; })[0] || SECTIONS[0];
  gid("title").textContent = sec.label;
  gid("crumb").textContent = sec.crumb;
  gid("headActions").innerHTML = "";
  paintNav();
  window.scrollTo(0,0);
  ({dashboard:viewDashboard, calendar:viewCalendar, rides:viewRides,
    customers:viewCustomers, invoices:viewInvoices, settings:viewSettings})[v]();
}

function drawer(html){
  gid("sheet").innerHTML = html;
  gid("drawer").style.display = "flex";
}
function closeDrawer(){ gid("drawer").style.display = "none"; }
gid("drawer").onclick = function(e){ if (e.target === gid("drawer")) closeDrawer(); };

/* ============================================================
   DASHBOARD
   ============================================================ */
function viewDashboard(){
  gid("view").innerHTML = '<div class="empty">Loading…</div>';
  Promise.all([api("/api/stats"), api("/api/bookings"), api("/api/invoices")]).then(function(r){
    S.stats = r[0].ok ? r[0].data : {};
    S.bookings = (r[1].ok && r[1].data.bookings) || [];
    S.invoices = (r[2].ok && r[2].data.invoices) || [];
    var s = S.stats;
    var today = todayStr();

    var upcoming = S.bookings.filter(function(b){
      return b.ride_date >= today && b.status !== "canceled";
    }).sort(function(a,b){
      return (a.ride_date + (a.ride_time||"")).localeCompare(b.ride_date + (b.ride_time||""));
    }).slice(0,6);

    var openInv = S.invoices.filter(function(i){ return i.status === "draft" || i.status === "sent"; }).slice(0,5);

    var trend = (s.trend||[]);
    var max = Math.max.apply(null, trend.map(function(t){ return Number(t.v)||0; }).concat([1]));

    gid("view").innerHTML =
      '<div class="kpis">' +
        kpi("Revenue this month", money0(s.revenueMonth), (s.ridesMonth||0) + " rides booked", true) +
        kpi("Outstanding", money0(s.outstanding), (s.unpaidInvoices||0) + " invoices awaiting payment") +
        kpi("Rides today", String(s.ridesToday||0), s.nextRide ? "Next: " + prettyDate(s.nextRide.ride_date) + " " + prettyTime(s.nextRide.ride_time) : "Nothing scheduled") +
        kpi("Customers", String(s.customers||0), money0(s.revenueAll) + " lifetime") +
      '</div>' +

      '<div class="panel"><div class="ph"><h3>Next up</h3>' +
        '<button class="btn ghost sm" id="toCal">Open calendar</button></div>' +
        '<div class="pb flush">' +
        (upcoming.length ? upcoming.map(rideRow).join("") : '<div class="empty">Nothing booked yet.</div>') +
        '</div></div>' +

      '<div class="panel"><div class="ph"><h3>Awaiting payment</h3>' +
        '<button class="btn ghost sm" id="toInv">All invoices</button></div>' +
        '<div class="pb flush">' +
        (openInv.length ? openInv.map(invRow).join("") : '<div class="empty">Everything is settled.</div>') +
        '</div></div>' +

      '<div class="panel"><div class="ph"><h3>Revenue, last 12 months</h3></div><div class="pb">' +
        (trend.length
          ? '<div class="spark">' + trend.map(function(t){
              var h = Math.round(((Number(t.v)||0)/max)*100);
              return '<i class="' + (h?"":"zero") + '" style="height:' + Math.max(h,2) + '%" title="' + esc(t.m) + ': $' + money(t.v) + '"></i>';
            }).join("") + '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:.62rem;color:var(--muted);margin-top:8px">' +
              '<span>' + esc(trend[0].m) + '</span><span>' + esc(trend[trend.length-1].m) + '</span></div>'
          : '<div class="empty">No captured revenue yet.</div>') +
      '</div></div>';

    gid("toCal").onclick = function(){ go("calendar"); };
    gid("toInv").onclick = function(){ go("invoices"); };
    wireRows();
  });
}

function kpi(k, v, s, gold){
  return '<div class="kpi' + (gold?" gold":"") + '"><div class="k">' + esc(k) + '</div>' +
    '<div class="v">' + esc(v) + '</div><div class="s">' + esc(s) + '</div></div>';
}

function rideRow(b){
  var paid = b.payment_status === "charged";
  return '<div class="row" data-ride="' + b.id + '"><div>' +
    '<div class="t">' + esc(prettyDate(b.ride_date)) + ' · ' + esc(prettyTime(b.ride_time)) +
      '<span class="pill ' + esc(b.status) + '">' + esc(b.status) + '</span></div>' +
    '<div class="m">' + esc(b.customer_name || "—") + ' · ' + esc(b.pickup || "") + ' → ' + esc(b.dropoff || "") + '</div>' +
    '</div><div class="n">' + (b.quoted_total != null ? "$" + money(b.quoted_total) : "—") +
    (paid ? '' : '') + '</div></div>';
}

function invRow(i){
  return '<div class="row" data-inv="' + i.id + '"><div>' +
    '<div class="t">' + esc(i.customer_name || "Customer") +
      '<span class="pill ' + esc(i.status) + '">' + esc(i.status) + '</span></div>' +
    '<div class="m">' + esc(i.number) + (i.due_date ? " · due " + esc(i.due_date) : "") + '</div>' +
    '</div><div class="n">$' + money(i.total) + '</div></div>';
}

function wireRows(){
  var rs = document.querySelectorAll("[data-ride]");
  for (var i=0;i<rs.length;i++){
    (function(el){ el.onclick = function(){ openRide(Number(el.getAttribute("data-ride"))); }; })(rs[i]);
  }
  var is = document.querySelectorAll("[data-inv]");
  for (var j=0;j<is.length;j++){
    (function(el){ el.onclick = function(){ openInvoice(Number(el.getAttribute("data-inv"))); }; })(is[j]);
  }
  var cs = document.querySelectorAll("[data-cust]");
  for (var k=0;k<cs.length;k++){
    (function(el){ el.onclick = function(){ openCustomer(Number(el.getAttribute("data-cust"))); }; })(cs[k]);
  }
}

/* ============================================================
   CALENDAR — month, week and day, like a calendar people already know
   ============================================================ */
function viewCalendar(){
  if (!S.cal.anchor) S.cal.anchor = todayStr();
  gid("headActions").innerHTML =
    '<button class="btn ghost sm" id="addOff" style="margin-right:8px">Block time off</button>' +
    '<button class="btn sm" id="addRide">New booking</button>';
  gid("addOff").onclick = function(){ openTimeOff(S.cal.anchor); };
  gid("addRide").onclick = function(){ openBooking(S.cal.anchor); };

  gid("view").innerHTML =
    '<div class="calbar">' +
      '<button class="nav-btn" id="cPrev">‹</button>' +
      '<button class="nav-btn" id="cNext">›</button>' +
      '<button class="btn ghost sm" id="cToday">Today</button>' +
      '<div class="title" id="cTitle">&nbsp;</div>' +
      '<div style="flex:1"></div>' +
      '<div class="seg">' +
        '<button data-m="month">Month</button>' +
        '<button data-m="week">Week</button>' +
        '<button data-m="day">Day</button>' +
      '</div>' +
    '</div><div id="calBody"></div>';

  var ms = document.querySelectorAll("[data-m]");
  for (var i=0;i<ms.length;i++){
    (function(b){
      b.classList.toggle("on", b.getAttribute("data-m") === S.cal.mode);
      b.onclick = function(){ S.cal.mode = b.getAttribute("data-m"); viewCalendar(); };
    })(ms[i]);
  }
  gid("cPrev").onclick = function(){ shift(-1); };
  gid("cNext").onclick = function(){ shift(1); };
  gid("cToday").onclick = function(){ S.cal.anchor = todayStr(); loadCal(); };
  loadCal();
}

function shift(dir){
  var d = dateFrom(S.cal.anchor);
  if (S.cal.mode === "month") d.setMonth(d.getMonth() + dir);
  else if (S.cal.mode === "week") d.setDate(d.getDate() + 7*dir);
  else d.setDate(d.getDate() + dir);
  S.cal.anchor = toYmd(d);
  loadCal();
}

function dateFrom(s){ var p = s.split("-"); return new Date(Number(p[0]), Number(p[1])-1, Number(p[2])); }
function toYmd(d){
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

/* Fetch whichever months the visible range touches. A week can straddle
   two months and a month grid always shows a few days of each neighbour,
   so one request is not always enough. */
function loadCal(){
  var months = {};
  var range = visibleRange();
  var cur = new Date(range.start.getTime());
  while (cur <= range.end){
    months[cur.getFullYear() + "-" + String(cur.getMonth()+1).padStart(2,"0")] = 1;
    cur.setDate(cur.getDate() + 1);
  }
  var keys = Object.keys(months);
  Promise.all(keys.map(function(m){ return api("/api/calendar?month=" + m); })).then(function(rs){
    var out = {bookings:[], blackouts:[], invoices:[]};
    rs.forEach(function(r){
      if (!r.ok) return;
      out.bookings = out.bookings.concat(r.data.bookings || []);
      out.blackouts = out.blackouts.concat(r.data.blackouts || []);
      out.invoices = out.invoices.concat(r.data.invoices || []);
    });
    S.cal.data = out;
    if (S.cal.mode === "month") paintMonth();
    else paintTime(S.cal.mode === "week" ? 7 : 1);
  });
}

function visibleRange(){
  var a = dateFrom(S.cal.anchor);
  if (S.cal.mode === "month"){
    var first = new Date(a.getFullYear(), a.getMonth(), 1);
    var start = new Date(first); start.setDate(1 - first.getDay());
    var last = new Date(a.getFullYear(), a.getMonth()+1, 0);
    var end = new Date(last); end.setDate(last.getDate() + (6 - last.getDay()));
    return {start:start, end:end};
  }
  if (S.cal.mode === "week"){
    var s = new Date(a); s.setDate(a.getDate() - a.getDay());
    var e = new Date(s); e.setDate(s.getDate() + 6);
    return {start:s, end:e};
  }
  return {start:new Date(a), end:new Date(a)};
}

function indexDays(){
  var by = {};
  var d = S.cal.data || {bookings:[],blackouts:[],invoices:[]};
  (d.bookings||[]).forEach(function(b){
    (by[b.ride_date] = by[b.ride_date] || {rides:[],off:[],due:[]}).rides.push(b);
  });
  (d.invoices||[]).forEach(function(i){
    if (!i.due_date) return;
    (by[i.due_date] = by[i.due_date] || {rides:[],off:[],due:[]}).due.push(i);
  });
  (d.blackouts||[]).forEach(function(bo){
    var s = new Date(bo.start_utc), e = new Date(bo.end_utc);
    // end is EXCLUSIVE: an all-day block runs to midnight at the start of
    // the next day, so <= would paint "Vacation" on the day after it ends.
    for (var t = s.getTime(); t < e.getTime(); t += 86400000){
      var k = ymd(t);
      (by[k] = by[k] || {rides:[],off:[],due:[]}).off.push(bo);
    }
  });
  return by;
}

function paintMonth(){
  var a = dateFrom(S.cal.anchor);
  gid("cTitle").textContent = a.toLocaleDateString("en-US",{month:"long",year:"numeric"});
  var by = indexDays();
  var r = visibleRange();
  var today = todayStr();
  var html = ["S","M","T","W","T","F","S"].map(function(d){ return '<div class="dow">' + d + '</div>'; }).join("");

  var cur = new Date(r.start.getTime());
  while (cur <= r.end){
    var key = toYmd(cur);
    var day = by[key] || {rides:[],off:[],due:[]};
    var out = cur.getMonth() !== a.getMonth();
    var evs = "";
    day.off.forEach(function(o){
      evs += '<div class="ev off" data-off="' + o.id + '">' + esc(o.label || "Time off") + '</div>';
    });
    day.rides.slice(0,3).forEach(function(b){
      var cls = b.payment_status === "charged" ? "" : " unpaid";
      evs += '<div class="ev' + cls + '" data-ride="' + b.id + '">' + esc(prettyTime(b.ride_time)) + ' ' +
             esc(b.customer_name || b.dest_code || "Ride") + '</div>';
    });
    day.due.forEach(function(i){ evs += '<div class="ev due" data-inv="' + i.id + '">' + esc(i.number) + ' due</div>'; });
    if (day.rides.length > 3) evs += '<div class="more">+' + (day.rides.length-3) + ' more</div>';

    html += '<div class="mcell' + (out?" out":"") + (key===today?" today":"") + '" data-day="' + key + '">' +
      '<span class="d">' + cur.getDate() + '</span>' + evs + '</div>';
    cur.setDate(cur.getDate()+1);
  }
  gid("calBody").innerHTML = '<div class="mgrid">' + html + '</div>';
  wireCal();
}

function paintTime(cols){
  var a = dateFrom(S.cal.anchor);
  var start = new Date(a);
  if (cols === 7) start.setDate(a.getDate() - a.getDay());
  var end = new Date(start); end.setDate(start.getDate() + cols - 1);

  gid("cTitle").textContent = cols === 1
    ? a.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})
    : start.toLocaleDateString("en-US",{month:"short",day:"numeric"}) + " – " +
      end.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});

  var by = indexDays();
  var today = todayStr();
  var H0 = 4, H1 = 23;                       // 4am to 11pm — Matt's actual day
  var rowH = 46;

  var head = '<div class="corner"></div>';
  var days = [];
  for (var c = 0; c < cols; c++){
    var d = new Date(start); d.setDate(start.getDate()+c);
    var key = toYmd(d);
    days.push(key);
    head += '<div class="colhead' + (key===today?" today":"") + '">' +
      d.toLocaleDateString("en-US",{weekday:"short"}) + '<b>' + d.getDate() + '</b></div>';
  }

  var body = "";
  for (var h = H0; h <= H1; h++){
    var ap = h >= 12 ? "pm" : "am"; var hh = h % 12; if (hh === 0) hh = 12;
    body += '<div class="hourlab">' + hh + ap + '</div>';
    for (var c2 = 0; c2 < cols; c2++){
      body += '<div class="tcol" data-slot="' + days[c2] + 'T' + String(h).padStart(2,"0") + '"></div>';
    }
  }

  gid("calBody").innerHTML =
    '<div class="tgrid" id="tgrid" style="--cols:' + cols + '">' + head + body + '</div>';

  // Events are absolutely positioned over their column, which is why the
  // grid is painted first and measured second.
  var grid = gid("tgrid");
  days.forEach(function(key, ci){
    var day = by[key] || {rides:[],off:[],due:[]};
    day.rides.forEach(function(b){
      var t = (b.ride_time || "00:00").split(":");
      var mins = Number(t[0])*60 + Number(t[1]||0) - H0*60;
      if (mins < 0) return;
      var dur = Math.max(0.75, Number(b.hours_engaged) || 1.5) * 60;
      var slot = grid.querySelector('[data-slot="' + key + 'T' + String(H0).padStart(2,"0") + '"]');
      if (!slot) return;
      var col = slot.offsetLeft, w = slot.offsetWidth;
      var el = document.createElement("div");
      el.className = "tev";
      el.setAttribute("data-ride", b.id);
      el.style.top = (slot.offsetTop + (mins/60)*rowH) + "px";
      el.style.left = (col + 3) + "px";
      el.style.width = (w - 6) + "px";
      el.style.height = Math.max(26, (dur/60)*rowH - 3) + "px";
      el.innerHTML = '<b>' + esc(prettyTime(b.ride_time)) + '</b>' +
        esc(b.customer_name || "") + (b.dropoff ? ' → ' + esc(b.dropoff) : "");
      grid.appendChild(el);
    });
    day.off.forEach(function(o){
      var s = new Date(o.start_utc), e = new Date(o.end_utc);
      var slot = grid.querySelector('[data-slot="' + key + 'T' + String(H0).padStart(2,"0") + '"]');
      if (!slot) return;
      var el = document.createElement("div");
      el.className = "tev off";
      el.setAttribute("data-off", o.id);
      el.style.top = slot.offsetTop + "px";
      el.style.left = (slot.offsetLeft + 3) + "px";
      el.style.width = (slot.offsetWidth - 6) + "px";
      el.style.height = ((H1-H0+1)*rowH - 4) + "px";
      el.innerHTML = '<b>' + esc(o.label || "Time off") + '</b>';
      grid.appendChild(el);
    });
  });
  wireCal();
}

function wireCal(){
  var cells = document.querySelectorAll("[data-day]");
  for (var i=0;i<cells.length;i++){
    (function(el){
      el.onclick = function(e){
        if (e.target !== el && e.target.className !== "d") return;  // let event chips win
        S.cal.anchor = el.getAttribute("data-day");
        S.cal.mode = "day"; viewCalendar();
      };
    })(cells[i]);
  }
  var slots = document.querySelectorAll("[data-slot]");
  for (var j=0;j<slots.length;j++){
    (function(el){
      el.onclick = function(){
        var v = el.getAttribute("data-slot").split("T");
        openBooking(v[0], v[1] + ":00");
      };
    })(slots[j]);
  }
  var offs = document.querySelectorAll("[data-off]");
  for (var k=0;k<offs.length;k++){
    (function(el){
      el.onclick = function(e){
        e.stopPropagation();
        openOff(Number(el.getAttribute("data-off")), el.textContent);
      };
    })(offs[k]);
  }
  wireRows();
}

function openOff(id, label){
  drawer(
    '<h2>Time off</h2><div class="sub">' + esc(label) + '</div>' +
    '<p>Nothing can be booked in this window.</p>' +
    '<button class="btn danger block" id="offDel" style="margin-top:16px">Remove this block</button>' +
    '<button class="btn ghost block" id="offClose" style="margin-top:9px">Close</button>'
  );
  gid("offClose").onclick = closeDrawer;
  gid("offDel").onclick = function(){
    api("/api/blackouts/" + id, {method:"DELETE"}).then(function(r){
      if (r.ok){ closeDrawer(); toast("Removed"); loadCal(); }
      else toast("Could not remove it");
    });
  };
}

/* Taking a booking over the phone. No card is collected: the customer
   is not standing there to enter one, and an admin typing somebody
   else's card number into a form is precisely the liability the public
   booking flow was built to avoid. Payment is an invoice with a link. */
function openBooking(dateStr, timeStr){
  if (!S.customers.length || !S.settings){
    Promise.all([
      S.customers.length ? Promise.resolve(null) : api("/api/customers"),
      S.settings ? Promise.resolve(null) : api("/api/settings")
    ]).then(function(r){
      if (r[0] && r[0].ok) S.customers = r[0].data.customers || [];
      if (r[1] && r[1].ok) S.settings = r[1].data;
      openBooking(dateStr, timeStr);
    });
    return;
  }
  var opts = (S.customers||[]).map(function(c){
    return '<option value="' + c.id + '">' + esc(c.name) + (c.phone ? " · " + esc(c.phone) : "") + '</option>';
  }).join("");
  var rates = (S.settings && S.settings.rates) || [];
  var rateOpts = rates.map(function(r){
    return '<option value="' + esc(r.code) + '" data-price="' + r.price + '" data-hours="' + r.hours + '">' +
      esc(r.label) + ' — $' + r.price + '</option>';
  }).join("");

  drawer(
    '<h2>New booking</h2><div class="sub">Taken by phone. No card is charged.</div>' +
    '<div class="field"><label>Customer</label><select id="bkCust"><option value="">— someone new —</option>' + opts + '</select></div>' +
    '<div id="bkNew">' +
      '<div class="field"><label>Name</label><input id="bkName"/></div>' +
      '<div class="acts2">' +
        '<div class="field"><label>Mobile</label><input id="bkPhone" inputmode="tel"/></div>' +
        '<div class="field"><label>Email</label><input id="bkEmail" inputmode="email"/></div>' +
      '</div>' +
    '</div>' +
    '<div class="acts2">' +
      '<div class="field"><label>Date</label><input type="date" id="bkDate" value="' + esc(dateStr || todayStr()) + '"/></div>' +
      '<div class="field"><label>Pickup time</label><input type="time" id="bkTime" step="900" value="' + esc(timeStr || "08:00") + '"/></div>' +
    '</div>' +
    '<div class="field"><label>Destination (sets the price and how long it blocks)</label>' +
      '<select id="bkRate"><option value="">— custom trip —</option>' + rateOpts + '</select></div>' +
    '<div class="field"><label>Pickup address</label><input id="bkPickup" placeholder="123 SE Ocean Blvd, Stuart"/></div>' +
    '<div class="field"><label>Drop off</label><input id="bkDrop" placeholder="Terminal, hotel, address"/></div>' +
    '<div class="acts2">' +
      '<div class="field"><label>Price ($)</label><input id="bkPrice" inputmode="decimal" placeholder="0.00"/></div>' +
      '<div class="field"><label>Hours it blocks</label><input id="bkHours" inputmode="decimal" placeholder="2"/></div>' +
    '</div>' +
    '<div class="acts2">' +
      '<div class="field"><label>Passengers</label><input id="bkPax" inputmode="numeric" value="1"/></div>' +
      '<div class="field"><label>Flight no.</label><input id="bkFlight" placeholder="AA1422"/></div>' +
    '</div>' +
    '<div class="field"><label>Notes</label><textarea id="bkNotes" rows="2" placeholder="Child seat, extra luggage, gate code…"></textarea></div>' +
    '<p class="err" id="bkErr"></p>' +
    '<button class="btn block" id="bkSave">Add to the calendar</button>' +
    '<button class="btn ghost block" id="bkCancel" style="margin-top:9px">Cancel</button>'
  );

  gid("bkCust").onchange = function(){
    gid("bkNew").style.display = gid("bkCust").value ? "none" : "block";
  };
  gid("bkRate").onchange = function(){
    var o = gid("bkRate").selectedOptions[0];
    if (!o || !o.value) return;
    if (!gid("bkPrice").value) gid("bkPrice").value = o.getAttribute("data-price");
    if (!gid("bkHours").value) gid("bkHours").value = o.getAttribute("data-hours");
  };
  gid("bkCancel").onclick = closeDrawer;

  function submit(force){
    var b = gid("bkSave"); b.disabled = true; b.textContent = "Saving…";
    gid("bkErr").textContent = "";
    api("/api/bookings", {method:"POST", body:{
      customerId: gid("bkCust").value || null,
      name: gid("bkName") ? gid("bkName").value.trim() : "",
      phone: gid("bkPhone") ? gid("bkPhone").value.trim() : "",
      email: gid("bkEmail") ? gid("bkEmail").value.trim() : "",
      date: gid("bkDate").value, time: gid("bkTime").value,
      destCode: gid("bkRate").value || null,
      pickup: gid("bkPickup").value.trim(), dropoff: gid("bkDrop").value.trim(),
      price: gid("bkPrice").value === "" ? null : Number(gid("bkPrice").value),
      hours: gid("bkHours").value === "" ? null : Number(gid("bkHours").value),
      passengers: gid("bkPax").value, flight: gid("bkFlight").value.trim(),
      notes: gid("bkNotes").value.trim(), force: force || false
    }}).then(function(r){
      b.disabled = false; b.textContent = "Add to the calendar";
      if (r.ok){
        closeDrawer(); toast("Added to the calendar");
        if (S.view === "calendar") loadCal(); else viewRides();
        return;
      }
      if (r.status === 409 && r.data && r.data.canForce){
        // A clash is worth a warning, not a veto — Matt knows things
        // the calendar does not.
        gid("bkErr").innerHTML = esc(r.data.error) +
          '<br/><button class="btn sm" id="bkForce" style="margin-top:8px">Book it anyway</button>';
        gid("bkForce").onclick = function(){ submit(true); };
        return;
      }
      gid("bkErr").textContent = (r.data && r.data.error) || "Could not save that.";
    });
  }
  gid("bkSave").onclick = function(){ submit(false); };
}

function openTimeOff(dateStr, hour){
  drawer(
    '<h2>Block time off</h2><div class="sub">Nothing can be booked in this window.</div>' +
    '<div class="field"><label>Date</label><input type="date" id="offDate" value="' + esc(dateStr||todayStr()) + '"/></div>' +
    '<div class="field"><label>Reason</label><input id="offLabel" placeholder="Vacation, appointment…"/></div>' +
    '<div class="field"><label><input type="checkbox" id="offAll" checked style="width:auto;margin-right:8px"/>All day</label></div>' +
    '<div class="acts2" id="offTimes" style="display:none">' +
      '<div class="field"><label>From</label><input type="time" id="offFrom" value="' + esc(hour ? hour + ":00" : "08:00") + '"/></div>' +
      '<div class="field"><label>To</label><input type="time" id="offTo" value="17:00"/></div>' +
    '</div>' +
    '<button class="btn block" id="offSave">Block it</button>' +
    '<button class="btn ghost block" id="offCancel" style="margin-top:9px">Cancel</button>'
  );
  gid("offAll").onchange = function(){
    gid("offTimes").style.display = gid("offAll").checked ? "none" : "grid";
  };
  gid("offCancel").onclick = closeDrawer;
  gid("offSave").onclick = function(){
    var allDay = gid("offAll").checked;
    var d = gid("offDate").value;
    if (!d) { toast("Pick a date"); return; }
    var body = { from: d, to: d, label: gid("offLabel").value || "Time off" };
    if (!allDay){ body.startTime = gid("offFrom").value; body.endTime = gid("offTo").value; }
    api("/api/blackouts", {method:"POST", body:body}).then(function(r){
      if (r.ok){ closeDrawer(); toast("Blocked"); loadCal(); }
      else toast((r.data && r.data.error) || "Could not save that");
    });
  };
}

/* ============================================================
   RIDES
   ============================================================ */
function viewRides(){
  gid("headActions").innerHTML = '<button class="btn sm" id="addRide2">New booking</button>';
  gid("addRide2").onclick = function(){ openBooking(todayStr()); };
  gid("view").innerHTML = '<div class="empty">Loading…</div>';
  api("/api/bookings").then(function(r){
    S.bookings = (r.ok && r.data.bookings) || [];
    paintRides("");
  });
}

function paintRides(q){
  var list = S.bookings.filter(function(b){
    if (!q) return true;
    var hay = [b.customer_name, b.pickup, b.dropoff, b.ride_date, b.dest_code].join(" ").toLowerCase();
    return hay.indexOf(q.toLowerCase()) !== -1;
  });
  gid("view").innerHTML =
    '<div class="searchbar"><input id="rq" placeholder="Search rides, names, addresses…" value="' + esc(q) + '"/></div>' +
    '<div class="panel"><div class="pb flush">' +
    (list.length ? list.map(rideRow).join("") : '<div class="empty">No rides match that.</div>') +
    '</div></div>';
  var box = gid("rq");
  box.oninput = function(){ var v = box.value; paintRides(v); gid("rq").focus(); };
  wireRows();
}

function openRide(id){
  var b = S.bookings.filter(function(x){ return x.id === id; })[0];
  if (!b){
    api("/api/bookings").then(function(r){
      S.bookings = (r.ok && r.data.bookings) || [];
      var f = S.bookings.filter(function(x){ return x.id === id; })[0];
      if (f) openRide(id);
    });
    return;
  }
  drawer(
    '<h2>' + esc(prettyDate(b.ride_date)) + '</h2>' +
    '<div class="sub">' + esc(prettyTime(b.ride_time)) + ' · ' + esc(b.customer_name || "—") + '</div>' +
    '<div class="dl"><span>Pickup</span><span>' + esc(b.pickup || "—") + '</span></div>' +
    '<div class="dl"><span>Drop off</span><span>' + esc(b.dropoff || "—") + '</span></div>' +
    '<div class="dl"><span>Passengers</span><span>' + esc(b.passengers || "—") + '</span></div>' +
    '<div class="dl"><span>Status</span><span>' + esc(b.status) + '</span></div>' +
    '<div class="dl"><span>Payment</span><span>' + esc(b.payment_status || "—") + '</span></div>' +
    '<div class="dl"><span>Quoted</span><span>' + (b.quoted_total != null ? "$" + money(b.quoted_total) : "—") + '</span></div>' +
    '<div class="dl"><span>Charged</span><span>' + (b.amount_charged ? "$" + money(b.amount_charged) : "—") + '</span></div>' +
    (b.notes ? '<div class="sechead">Notes</div><p>' + esc(b.notes) + '</p>' : "") +
    (b.customer_phone ? '<div class="acts2">' +
      '<a class="btn ghost" href="tel:' + esc(b.customer_phone) + '">Call</a>' +
      '<a class="btn ghost" href="sms:' + esc(b.customer_phone) + '">Text</a></div>' : "") +
    '<div class="sechead">Reschedule</div>' +
    '<div class="acts2">' +
      '<div class="field"><label>Date</label><input type="date" id="edDate" value="' + esc(b.ride_date || "") + '"/></div>' +
      '<div class="field"><label>Time</label><input type="time" id="edTime" step="900" value="' + esc(b.ride_time || "") + '"/></div>' +
    '</div>' +
    '<div class="acts2">' +
      '<div class="field"><label>Price ($)</label><input id="edPrice" inputmode="decimal" value="' + (b.quoted_total != null ? b.quoted_total : "") + '"/></div>' +
      '<div class="field"><label>Status</label><select id="edStatus">' +
        ["new","confirmed","done"].map(function(x){
          return '<option value="' + x + '"' + (b.status===x?" selected":"") + '>' + x + '</option>';
        }).join("") + '</select></div>' +
    '</div>' +
    '<button class="btn block" id="edSave">Save changes</button>' +
    (b.status !== "canceled"
      ? '<div class="sechead">Cancel</div>' +
        (Number(b.amount_charged) > 0
          ? '<label style="text-transform:none;letter-spacing:0;font-size:.85rem;color:var(--body)">' +
            '<input type="checkbox" id="edRefund" checked style="width:auto;margin-right:8px"/>' +
            'Also refund the $' + money(b.amount_charged) + ' already charged</label>'
          : '<p style="font-size:.85rem;color:var(--muted)">Nothing has been charged for this ride.</p>') +
        '<button class="btn danger block" id="edCancel" style="margin-top:10px">Cancel this ride</button>'
      : '') +
    '<button class="btn ghost block" id="rClose" style="margin-top:12px">Close</button>'
  );
  gid("rClose").onclick = closeDrawer;
  gid("edSave").onclick = function(){
    var btn = gid("edSave"); btn.disabled = true; btn.textContent = "Saving…";
    api("/api/bookings/" + b.id + "/edit", {method:"PATCH", body:{
      date: gid("edDate").value, time: gid("edTime").value,
      price: gid("edPrice").value === "" ? null : Number(gid("edPrice").value),
      status: gid("edStatus").value
    }}).then(function(r){
      btn.disabled = false; btn.textContent = "Save changes";
      if (!r.ok){ toast((r.data && r.data.error) || "Could not save"); return; }
      toast("Ride updated"); closeDrawer();
      if (S.view === "calendar") loadCal(); else viewRides();
    });
  };

  if (gid("edCancel")) gid("edCancel").onclick = function(){
    var btn = gid("edCancel"); btn.disabled = true; btn.textContent = "Cancelling…";
    var wantRefund = gid("edRefund") ? gid("edRefund").checked : false;
    api("/api/bookings/" + b.id + "/cancel", {method:"POST", body:{refund: wantRefund}}).then(function(r){
      btn.disabled = false; btn.textContent = "Cancel this ride";
      if (!r.ok){ toast((r.data && r.data.error) || "Could not cancel"); return; }
      toast(r.data.refunded ? "Cancelled and money returned" : "Cancelled");
      closeDrawer();
      if (S.view === "calendar") loadCal(); else viewRides();
    });
  };
}

/* ============================================================
   CUSTOMERS
   ============================================================ */
function viewCustomers(){
  gid("view").innerHTML = '<div class="empty">Loading…</div>';
  api("/api/customers").then(function(r){
    S.customers = (r.ok && r.data.customers) || [];
    paintCustomers("");
  });
}

function paintCustomers(q){
  var list = S.customers.filter(function(c){
    if (!q) return true;
    return [c.name,c.email,c.phone].join(" ").toLowerCase().indexOf(q.toLowerCase()) !== -1;
  });
  gid("view").innerHTML =
    '<div class="searchbar"><input id="cq" placeholder="Search by name, email or phone…" value="' + esc(q) + '"/></div>' +
    '<div class="panel"><div class="pb flush">' +
    (list.length ? list.map(function(c){
      return '<div class="row" data-cust="' + c.id + '"><div>' +
        '<div class="t">' + esc(c.name) + '</div>' +
        '<div class="m">' + esc(c.phone || "") + (c.email ? " · " + esc(c.email) : "") + '</div>' +
        '</div><div class="n">' + (c.ride_count || 0) + '</div></div>';
    }).join("") : '<div class="empty">No customers match that.</div>') +
    '</div></div>';
  var box = gid("cq");
  box.oninput = function(){ var v = box.value; paintCustomers(v); gid("cq").focus(); };
  wireRows();
}

function openCustomer(id){
  api("/api/customers/" + id).then(function(r){
    if (!r.ok) { toast("Could not load that customer"); return; }
    var d = r.data, c = d.customer, t = d.totals;
    drawer(
      '<h2>' + esc(c.name) + '</h2>' +
      '<div class="sub">' + esc(c.phone || "") + (c.email ? " · " + esc(c.email) : "") + '</div>' +
      '<div class="kpis" style="grid-template-columns:1fr 1fr">' +
        kpi("Lifetime", money0(t.lifetimeValue), t.rideCount + " rides", true) +
        kpi("Last ride", t.lastRide ? prettyDate(t.lastRide) : "—", t.openInvoices + " open invoices") +
      '</div>' +

      '<div class="sechead">Contact</div>' +
      '<div class="field"><label>Name</label><input id="cuName" value="' + esc(c.name) + '"/></div>' +
      '<div class="field"><label>Email</label><input id="cuEmail" value="' + esc(c.email || "") + '"/></div>' +
      '<div class="field"><label>Mobile</label><input id="cuPhone" value="' + esc(c.phone || "") + '"/></div>' +
      '<div class="field"><label>Private notes</label><textarea id="cuNotes" rows="3">' + esc(c.notes || "") + '</textarea></div>' +
      '<button class="btn block" id="cuSave">Save</button>' +

      '<div class="sechead">Rides</div>' +
      (d.rides.length ? d.rides.slice(0,12).map(function(b){
        return '<div class="dl"><span>' + esc(prettyDate(b.ride_date)) + ' ' + esc(prettyTime(b.ride_time)) + '</span>' +
          '<span>' + (b.amount_charged ? "$" + money(b.amount_charged) : (b.quoted_total ? "$" + money(b.quoted_total) : "—")) +
          '<span class="pill ' + esc(b.status) + '">' + esc(b.status) + '</span></span></div>';
      }).join("") : '<div class="empty">No rides yet.</div>') +

      '<div class="sechead">Invoices</div>' +
      (d.invoices.length ? d.invoices.map(function(i){
        return '<div class="dl"><span>' + esc(i.number) + '</span><span>$' + money(i.total) +
          '<span class="pill ' + esc(i.status) + '">' + esc(i.status) + '</span></span></div>';
      }).join("") : '<div class="empty">No invoices yet.</div>') +

      '<div class="sechead">Messages</div>' +
      (d.messages.length ? d.messages.map(function(m){
        return '<div class="dl"><span>' + esc((m.created_at||"").slice(0,16)) + ' · ' + esc(m.channel) + '</span>' +
          '<span>' + esc(m.subject || m.to_addr || "") +
          '<span class="pill ' + (m.status==="sent"?"paid":"void") + '">' + esc(m.status) + '</span></span></div>';
      }).join("") : '<div class="empty">Nothing sent yet.</div>') +

      '<div class="acts2" style="margin-top:20px">' +
        (c.phone ? '<a class="btn ghost" href="tel:' + esc(c.phone) + '">Call</a>' : '<span></span>') +
        '<button class="btn ghost" id="cuInvoice">New invoice</button>' +
      '</div>' +
      '<button class="btn ghost block" id="cuClose" style="margin-top:9px">Close</button>'
    );
    gid("cuClose").onclick = closeDrawer;
    gid("cuInvoice").onclick = function(){ openInvoiceComposer(c.id, c.name); };
    gid("cuSave").onclick = function(){
      api("/api/customers/" + c.id, {method:"PATCH", body:{
        name: gid("cuName").value, email: gid("cuEmail").value,
        phone: gid("cuPhone").value, notes: gid("cuNotes").value
      }}).then(function(rr){
        if (rr.ok){ toast("Saved"); viewCustomers(); closeDrawer(); }
        else toast((rr.data && rr.data.error) || "Could not save");
      });
    };
  });
}

/* ============================================================
   INVOICES
   ============================================================ */
function viewInvoices(){
  gid("headActions").innerHTML = '<button class="btn sm" id="newInv">New invoice</button>';
  gid("newInv").onclick = function(){ openInvoiceComposer(); };
  gid("view").innerHTML = '<div class="empty">Loading…</div>';
  Promise.all([api("/api/invoices"), api("/api/customers")]).then(function(r){
    S.invoices = (r[0].ok && r[0].data.invoices) || [];
    S.customers = (r[1].ok && r[1].data.customers) || [];
    var open = S.invoices.filter(function(i){ return i.status==="draft" || i.status==="sent"; });
    var done = S.invoices.filter(function(i){ return i.status==="paid" || i.status==="void"; });
    gid("view").innerHTML =
      '<div class="panel"><div class="ph"><h3>Awaiting payment</h3><span style="font-size:.8rem;color:var(--muted)">' +
        money0(open.reduce(function(s,i){ return s + Number(i.total||0); },0)) + ' outstanding</span></div>' +
        '<div class="pb flush">' + (open.length ? open.map(invRow).join("") : '<div class="empty">Everything is settled.</div>') + '</div></div>' +
      '<div class="panel"><div class="ph"><h3>Settled</h3></div><div class="pb flush">' +
        (done.length ? done.map(invRow).join("") : '<div class="empty">Nothing yet.</div>') + '</div></div>';
    wireRows();
  });
}

function itemRow(){
  return '<div class="li"><input placeholder="Airport transfer — PBI" class="ilabel"/>' +
    '<input inputmode="numeric" value="1" class="iqty"/>' +
    '<input inputmode="decimal" placeholder="0.00" class="iprice"/>' +
    '<button class="x" type="button">×</button></div>';
}

function openInvoiceComposer(custId, custName){
  var opts = S.customers.map(function(c){
    return '<option value="' + c.id + '"' + (custId===c.id?" selected":"") + '>' +
      esc(c.name) + (c.phone ? " · " + esc(c.phone) : "") + '</option>';
  }).join("");
  drawer(
    '<h2>New invoice</h2><div class="sub">' + esc(custName || "Bill anyone for anything") + '</div>' +
    '<div class="field"><label>Customer</label><select id="ivCust"><option value="">— someone new —</option>' + opts + '</select></div>' +
    '<div id="ivNew">' +
      '<div class="field"><label>Name</label><input id="ivName"/></div>' +
      '<div class="field"><label>Email</label><input id="ivEmail"/></div>' +
      '<div class="field"><label>Mobile</label><input id="ivPhone"/></div>' +
    '</div>' +
    '<div class="sechead">Line items</div><div id="ivItems">' + itemRow() + '</div>' +
    '<button class="btn ghost block" type="button" id="ivAdd">Add line</button>' +
    '<div class="acts2" style="margin-top:14px">' +
      '<div class="field"><label>Gratuity ($)</label><input id="ivTip" inputmode="decimal" placeholder="0.00"/></div>' +
      '<div class="field"><label>Due date</label><input id="ivDue" type="date"/></div>' +
    '</div>' +
    '<div class="field"><label>Note to the customer</label><textarea id="ivNotes" rows="2"></textarea></div>' +
    '<div class="dl"><span>Total</span><span id="ivTotal" style="font:500 1.4rem/1 var(--serif)">$0.00</span></div>' +
    '<button class="btn block" id="ivSave" style="margin-top:14px">Create invoice</button>' +
    '<button class="btn ghost block" id="ivCancel" style="margin-top:9px">Cancel</button>'
  );
  if (custId) gid("ivNew").style.display = "none";

  function calc(){
    var t = 0, rows = gid("ivItems").children;
    for (var i=0;i<rows.length;i++){
      t += (Number(rows[i].querySelector(".iqty").value)||0) * (Number(rows[i].querySelector(".iprice").value)||0);
    }
    t += Number(gid("ivTip").value)||0;
    gid("ivTotal").textContent = "$" + money(t);
  }
  function wire(){
    var xs = gid("ivItems").querySelectorAll(".x");
    for (var i=0;i<xs.length;i++){
      (function(b){ b.onclick = function(){
        if (gid("ivItems").children.length > 1) b.parentNode.remove(); calc();
      }; })(xs[i]);
    }
    var ins = gid("ivItems").querySelectorAll("input");
    for (var j=0;j<ins.length;j++) ins[j].oninput = calc;
  }
  wire();
  gid("ivTip").oninput = calc;
  gid("ivAdd").onclick = function(){ gid("ivItems").insertAdjacentHTML("beforeend", itemRow()); wire(); };
  gid("ivCust").onchange = function(){ gid("ivNew").style.display = gid("ivCust").value ? "none" : "block"; };
  gid("ivCancel").onclick = closeDrawer;

  gid("ivSave").onclick = function(){
    var items = [], rows = gid("ivItems").children;
    for (var i=0;i<rows.length;i++){
      var label = rows[i].querySelector(".ilabel").value.trim();
      if (!label) continue;
      items.push({ label: label,
        qty: Number(rows[i].querySelector(".iqty").value)||1,
        unitPrice: Number(rows[i].querySelector(".iprice").value)||0 });
    }
    if (!items.length){ toast("Add at least one line"); return; }
    var b = gid("ivSave"); b.disabled = true; b.textContent = "Creating…";
    api("/api/invoices", {method:"POST", body:{
      customerId: gid("ivCust").value || null,
      name: gid("ivName") ? gid("ivName").value.trim() : "",
      email: gid("ivEmail") ? gid("ivEmail").value.trim() : "",
      phone: gid("ivPhone") ? gid("ivPhone").value.trim() : "",
      items: items, tip: Number(gid("ivTip").value)||0,
      dueDate: gid("ivDue").value || null,
      notes: gid("ivNotes").value.trim() || null
    }}).then(function(r){
      b.disabled = false; b.textContent = "Create invoice";
      if (!r.ok){ toast((r.data && r.data.error) || "Could not create it"); return; }
      openInvoiceDetail(r.data.invoice);
      if (S.view === "invoices") viewInvoices();
    });
  };
}

function openInvoice(id){
  api("/api/invoices/" + id).then(function(r){
    if (r.ok) openInvoiceDetail(r.data.invoice);
  });
}

function openInvoiceDetail(inv){
  var paid = inv.status === "paid";
  drawer(
    '<h2>Invoice ' + esc(inv.number) + '</h2>' +
    '<div class="sub">' + esc(inv.customer_name || "") + '</div>' +
    (inv.items||[]).map(function(it){
      return '<div class="dl"><span>' + esc(it.label) + (it.qty>1 ? " × " + it.qty : "") +
        '</span><span>$' + money(it.amount) + '</span></div>';
    }).join("") +
    (inv.tip > 0 ? '<div class="dl"><span>Gratuity</span><span>$' + money(inv.tip) + '</span></div>' : "") +
    '<div class="dl" style="border-top:2px solid var(--ink);margin-top:8px;padding-top:14px">' +
      '<span style="color:var(--ink);font-weight:600">Total</span>' +
      '<span style="font:500 1.5rem/1 var(--serif)">$' + money(inv.total) + '</span></div>' +
    (paid
      ? '<div class="sechead">Paid</div><div class="dl"><span>' + esc((inv.paid_at||"").slice(0,16)) + '</span>' +
        '<span>' + (inv.card_last4 ? "card ending " + esc(inv.card_last4) : "") + '</span></div>' +
        '<button class="btn danger block" id="ivRefund" style="margin-top:12px">Refund $' + money(inv.total) + '</button>' 
      : '<div class="sechead">Payment link</div>' +
        '<div class="linkbox"><input id="ivLink" readonly value="' + esc(inv.pay_url || "") + '"/>' +
        '<button class="btn ghost sm" id="ivCopy">Copy</button></div>' +
        '<div class="acts2"><button class="btn" id="ivEmail">Email link</button>' +
        '<button class="btn" id="ivSms">Text link</button></div>' +
        '<button class="btn danger block" id="ivVoid" style="margin-top:9px">Void invoice</button>') +
    '<button class="btn ghost block" id="ivClose" style="margin-top:9px">Close</button>'
  );
  gid("ivClose").onclick = closeDrawer;
  if (paid){
    gid("ivRefund").onclick = function(){
      var b = gid("ivRefund"); b.disabled = true; b.textContent = "Refunding…";
      api("/api/invoices/" + inv.id + "/refund", {method:"POST"}).then(function(r){
        b.disabled = false; b.textContent = "Refund $" + money(inv.total);
        if (!r.ok){ toast((r.data && r.data.error) || "The bank refused it"); return; }
        toast(r.data.mode === "void" ? "Voided before settlement" : "Refunded");
        closeDrawer(); viewInvoices();
      });
    };
    return;
  }

  gid("ivCopy").onclick = function(){
    var f = gid("ivLink"); f.select(); f.setSelectionRange(0,99999);
    if (navigator.clipboard) navigator.clipboard.writeText(f.value); else document.execCommand("copy");
    toast("Link copied");
  };
  gid("ivEmail").onclick = function(){
    var b = gid("ivEmail"); b.disabled = true; b.textContent = "Sending…";
    api("/api/invoices/" + inv.id + "/email", {method:"POST"}).then(function(r){
      b.disabled = false; b.textContent = "Email link";
      toast(r.ok ? "Emailed" : ((r.data && r.data.error) || "Email failed"));
      if (r.ok && S.view === "invoices") viewInvoices();
    });
  };
  gid("ivSms").onclick = function(){
    var b = gid("ivSms"); b.disabled = true; b.textContent = "…";
    api("/api/invoices/" + inv.id + "/sms", {method:"POST"}).then(function(r){
      b.disabled = false; b.textContent = "Text link";
      if (!r.ok){ toast((r.data && r.data.error) || "Could not text it"); return; }
      if (r.data.mode === "sent"){ toast("Texted"); return; }
      toast("Opening Messages…");
      window.location.href = r.data.smsHref;
    });
  };
  gid("ivVoid").onclick = function(){
    api("/api/invoices/" + inv.id + "/void", {method:"POST"}).then(function(r){
      if (r.ok){ closeDrawer(); toast("Voided"); viewInvoices(); }
      else toast((r.data && r.data.error) || "Could not void it");
    });
  };
}

/* ============================================================
   SETTINGS
   ============================================================ */
function viewSettings(){
  gid("view").innerHTML = '<div class="empty">Loading…</div>';
  api("/api/settings").then(function(r){
    if (!r.ok){ gid("view").innerHTML = '<div class="empty">Could not load settings.</div>'; return; }
    S.settings = r.data;
    var groups = {};
    r.data.fields.forEach(function(f){ (groups[f.group] = groups[f.group] || []).push(f); });

    var html = "";
    Object.keys(groups).forEach(function(g){
      html += '<div class="panel"><div class="ph"><h3>' + esc(g) + '</h3></div><div class="pb">' +
        '<div class="setgrid">' + groups[g].map(function(f){
          if (f.type === "bool"){
            return '<div class="field"><label>' + esc(f.label) + '</label>' +
              '<select data-set="' + f.key + '">' +
                '<option value="1"' + (f.value==="1"?" selected":"") + '>Yes</option>' +
                '<option value="0"' + (f.value!=="1"?" selected":"") + '>No</option></select></div>';
          }
          var type = f.type === "number" ? "number" : (f.type === "time" ? "time" : "text");
          return '<div class="field"><label>' + esc(f.label) + '</label>' +
            '<input type="' + type + '" step="any" data-set="' + esc(f.key) + '" value="' + esc(f.value) + '"/></div>';
        }).join("") + '</div>' +
        '<button class="btn sm" data-save="' + esc(g) + '">Save ' + esc(g.toLowerCase()) + '</button>' +
      '</div></div>';
    });

    html += '<div class="panel"><div class="ph"><h3>Rate sheet</h3></div><div class="pb flush">' +
      r.data.rates.map(function(rt){
        return '<div class="row" style="cursor:default"><div><div class="t">' + esc(rt.label) + '</div>' +
          '<div class="m">' + esc(rt.code) + ' · ' + rt.hours + ' h engaged' + (rt.miles ? ' · ' + rt.miles + ' mi' : '') + '</div></div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<input style="width:100px" inputmode="decimal" data-rate="' + esc(rt.code) + '" value="' + rt.price + '"/>' +
            '<button class="btn ghost sm" data-rsave="' + esc(rt.code) + '">Save</button></div></div>';
      }).join("") + '</div></div>';

    html += '<div class="panel"><div class="ph"><h3>Security</h3></div><div class="pb">' +
      '<div class="setgrid">' +
        '<div class="field"><label>Current password</label><input type="password" id="pwCur" autocomplete="current-password"/></div>' +
        '<div class="field"><label>New password</label><input type="password" id="pwNew" autocomplete="new-password"/></div>' +
        '<div class="field"><label>Confirm new password</label><input type="password" id="pwNew2" autocomplete="new-password"/></div>' +
      '</div>' +
      '<button class="btn sm" id="pwSave">Change password</button>' +
      '<p style="font-size:.8rem;color:var(--muted);margin-top:12px">' +
        (r.data.passwordIsCustom
          ? 'Your password is stored here as a hash. Changing it signs out every other device immediately.'
          : 'You are still signing in with the original setup password. Change it here to take ownership of the account — that also retires the setup password for good.') +
      '</p></div></div>' +

      '<div class="panel"><div class="ph"><h3>Signed-in devices</h3>' +
        '<button class="btn ghost sm" id="revokeAll">Sign out everywhere else</button></div>' +
        '<div class="pb flush" id="sessList"><div class="empty">Loading…</div></div></div>' +

      '<div class="panel"><div class="ph"><h3>Backup</h3>' +
        '<a class="btn ghost sm" href="/api/export" download>Download a backup</a></div>' +
        '<div class="pb"><p style="font-size:.85rem;color:var(--muted);margin:0">' +
        'Every customer, ride, invoice and payment as one JSON file. Keep a copy somewhere ' +
        'that is not Cloudflare. Your password and session tokens are not included.' +
        '</p></div></div>' +

      '<div class="panel"><div class="ph"><h3>Activity</h3>' +
        '<span style="font-size:.75rem;color:var(--muted)">Everything that changed money or settings</span></div>' +
        '<div class="pb flush" id="auditList"><div class="empty">Loading…</div></div></div>';

    html += '<div class="panel"><div class="ph"><h3>Connections</h3></div><div class="pb">' +
      conn("Email (Resend)", r.data.integrations.resend, r.data.notifications.from) +
      conn("Card payments (Authorize.net)", r.data.integrations.authorizeNet, r.data.integrations.mode) +
      conn("Texting", r.data.integrations.twilio,
           r.data.integrations.twilio ? "Sends automatically" : "No number yet — texts open your Messages app instead") +
      '<div class="dl"><span>Notifications go to</span><span>' + esc(r.data.notifications.to) + '</span></div>' +
    '</div></div>';

    gid("view").innerHTML = html;

    var saves = document.querySelectorAll("[data-save]");
    for (var i=0;i<saves.length;i++){
      (function(b){
        b.onclick = function(){
          var body = {};
          var inputs = document.querySelectorAll("[data-set]");
          for (var j=0;j<inputs.length;j++) body[inputs[j].getAttribute("data-set")] = inputs[j].value;
          b.disabled = true;
          api("/api/settings", {method:"PATCH", body:body}).then(function(rr){
            b.disabled = false;
            toast(rr.ok ? "Saved" : ((rr.data && rr.data.error) || "Could not save"));
          });
        };
      })(saves[i]);
    }

    var rsaves = document.querySelectorAll("[data-rsave]");
    for (var k=0;k<rsaves.length;k++){
      (function(b){
        var code = b.getAttribute("data-rsave");
        b.onclick = function(){
          var input = document.querySelector('[data-rate="' + code + '"]');
          b.disabled = true;
          api("/api/rates/" + code, {method:"PATCH", body:{price: Number(input.value)}}).then(function(rr){
            b.disabled = false;
            toast(rr.ok ? code + " updated" : ((rr.data && rr.data.error) || "Could not save"));
          });
        };
      })(rsaves[k]);
    }

    loadSessions();
    loadAudit();
    gid("revokeAll").onclick = function(){
      api("/api/sessions/revoke-all", {method:"POST"}).then(function(rr){
        toast(rr.ok ? "Every other device signed out" : "Could not do that");
        loadSessions();
      });
    };

    gid("pwSave").onclick = function(){
      var cur = gid("pwCur").value, nw = gid("pwNew").value, nw2 = gid("pwNew2").value;
      if (nw !== nw2){ toast("The two new passwords do not match"); return; }
      if (nw.length < 10){ toast("Use at least 10 characters"); return; }
      var b = gid("pwSave"); b.disabled = true;
      api("/api/password", {method:"POST", body:{current:cur, next:nw}}).then(function(rr){
        b.disabled = false;
        if (rr.ok){ toast("Password changed"); gid("pwCur").value=""; gid("pwNew").value=""; gid("pwNew2").value=""; viewSettings(); }
        else toast((rr.data && rr.data.error) || "Could not change it");
      });
    };
  });
}

function loadSessions(){
  api("/api/sessions").then(function(r){
    var box = gid("sessList");
    if (!box) return;
    var list = (r.ok && r.data.sessions) || [];
    if (!list.length){ box.innerHTML = '<div class="empty">No active sessions.</div>'; return; }
    box.innerHTML = list.map(function(x){
      return '<div class="row" style="cursor:default"><div>' +
        '<div class="t">' + esc(x.device) + (x.current ? '<span class="pill paid">this device</span>' : '') + '</div>' +
        '<div class="m">' + esc(x.ip || "unknown IP") + ' · last used ' + esc((x.lastSeenAt || x.createdAt || "").slice(0,16)) + '</div>' +
        '</div>' +
        (x.current ? '<span style="font-size:.75rem;color:var(--muted)">active</span>'
                   : '<button class="btn ghost sm" data-sess="' + x.id + '">Sign out</button>') +
        '</div>';
    }).join("");
    var bs = box.querySelectorAll("[data-sess]");
    for (var i=0;i<bs.length;i++){
      (function(b){
        b.onclick = function(){
          api("/api/sessions/" + b.getAttribute("data-sess"), {method:"DELETE"}).then(function(rr){
            toast(rr.ok ? "Signed out" : "Could not sign that out");
            loadSessions();
          });
        };
      })(bs[i]);
    }
  });
}

function loadAudit(){
  api("/api/audit?limit=60").then(function(r){
    var box = gid("auditList");
    if (!box) return;
    var list = (r.ok && r.data.events) || [];
    if (!list.length){ box.innerHTML = '<div class="empty">Nothing recorded yet.</div>'; return; }
    box.innerHTML = list.map(function(e){
      return '<div class="row" style="cursor:default"><div>' +
        '<div class="t">' + esc(e.summary || e.action) + '</div>' +
        '<div class="m">' + esc((e.created_at || "").slice(0,16)) + ' · ' + esc(e.action) +
          (e.ip ? ' · ' + esc(e.ip) : '') + '</div></div></div>';
    }).join("");
  });
}

function conn(label, on, detail){
  return '<div class="dl"><span>' + esc(label) + '</span><span>' +
    '<span class="pill ' + (on ? "paid" : "draft") + '">' + (on ? "connected" : "not set") + '</span>' +
    (detail ? ' <span style="color:var(--muted)">' + esc(detail) + '</span>' : "") + '</span></div>';
}

/* ============================================================
   AUTH
   ============================================================ */
function enterApp(){
  gid("login").style.display = "none";
  gid("app").style.display = "block";
  paintNav();
  go("dashboard");
}

function doLogin(){
  var b = gid("loginBtn"); b.disabled = true;
  api("/admin/login", {method:"POST", body:{password: gid("pw").value}}).then(function(r){
    b.disabled = false;
    if (r.ok) enterApp();
    else gid("loginErr").textContent = "That password is not right.";
  });
}
gid("loginBtn").onclick = doLogin;
gid("pw").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
gid("signout").onclick = function(){
  api("/admin/logout", {method:"POST"}).then(function(){ location.reload(); });
};

api("/api/me").then(function(r){ if (r.data && r.data.authed) enterApp(); });
})();
</script>
</body>
</html>`;
