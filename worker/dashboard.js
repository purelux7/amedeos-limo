/* ============================================================
   Matt's dashboard, served at /admin.

   Designed for a phone held in one hand at 5am, not a desktop.
   Payment state is READ ONLY here — the system charges cards, not
   Matt. The old manual "price" box and "paid/unpaid" toggle are gone
   on purpose: two sources of truth for whether a ride was paid is how
   people end up double-charging customers.

   Embedded JS deliberately avoids template literals so that `${...}`
   inside this module's own template string can never collide.
   ============================================================ */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<meta name="theme-color" content="#14171c"/>
<title>Amedeo's</title>
<style>
  :root{--navy:#14171c;--navy2:#232830;--gold:#c8a961;--gold-d:#8a6d2f;
        --metal:linear-gradient(135deg,#e0c894 0%,#a8873f 34%,#8a6d2f 58%,#d6bd84 100%);
        --ink:#14171c;--muted:#8a929d;--line:#e6e8ec;--bg:#f6f7f9;
        --ok:#1f7a4d;--ok-bg:#e9f6ee;--warn:#9a6b12;--warn-bg:#fdf3e2;
        --bad:#b03a3a;--bad-bg:#f6e9e9;}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;
       background:var(--bg);color:var(--ink);line-height:1.5}

  /* login */
  #login{position:fixed;inset:0;background:var(--navy);display:flex;align-items:center;
         justify-content:center;padding:24px;z-index:50}
  .login-card{background:#fff;border-radius:14px;padding:30px 26px;width:100%;max-width:340px;text-align:center}
  .login-card h1{font-size:1.2rem;margin:0 0 4px}
  .login-card .sub{color:var(--gold-d);font-size:.72rem;letter-spacing:.12em;
                   text-transform:uppercase;margin-bottom:22px;font-weight:700}
  input,select,textarea{font:inherit;width:100%;padding:12px 13px;border:1px solid var(--line);
                        border-radius:9px;background:#fff;color:var(--ink)}
  .btn{border:none;border-radius:9px;padding:13px 16px;font-weight:700;cursor:pointer;
       background:var(--gold-d);color:#fff;font-size:.95rem}
  .btn.block{width:100%}
  .btn.ghost{background:#fff;color:var(--navy2);border:1px solid var(--line)}
  .btn.danger{background:var(--bad)}
  .err{color:var(--bad);font-size:.85rem;margin-top:10px;min-height:1em}

  /* shell */
  #app{display:none;padding-bottom:78px}
  header{background:var(--navy);color:#fff;padding:15px 18px;position:sticky;top:0;z-index:20;
         display:flex;justify-content:space-between;align-items:center;gap:10px}
  header .brand{font-weight:800;font-size:1rem;line-height:1.2}
  header .brand small{display:block;color:var(--gold);font-size:.6rem;letter-spacing:.14em;
                      text-transform:uppercase;font-weight:700;margin-top:2px}
  header .dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}
  header .dot.ok{background:#37c47f}
  header .dot.bad{background:#ff6b6b}
  .wrap{padding:14px}
  h2.day{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);
         margin:16px 2px 8px;font-weight:800}
  h2.day:first-child{margin-top:2px}
  .pad{padding:34px 20px;text-align:center;color:var(--muted)}

  /* ride card */
  .ride{background:#fff;border:1px solid var(--line);border-radius:13px;padding:15px;
        margin-bottom:12px;box-shadow:0 4px 14px rgba(16,35,64,.05)}
  .ride.next{border-color:var(--gold);box-shadow:0 6px 20px rgba(168,128,31,.16)}
  .ride .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .ride .time{font-size:1.45rem;font-weight:800;letter-spacing:-.02em;line-height:1.1}
  .ride .date{font-size:.78rem;color:var(--muted);font-weight:600}
  .badge{font-size:.64rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;
         padding:4px 9px;border-radius:20px;white-space:nowrap}
  .badge.paid{background:var(--ok-bg);color:var(--ok)}
  .badge.pending{background:var(--warn-bg);color:var(--warn)}
  .badge.failed{background:var(--bad-bg);color:var(--bad)}
  .badge.nocard{background:var(--bad-bg);color:var(--bad)}
  .badge.canceled{background:var(--line);color:var(--muted)}
  .who{margin:11px 0 3px;font-weight:700;font-size:1.02rem}
  .route{font-size:.92rem;color:#384559;margin:7px 0;line-height:1.55}
  .route .pin{color:var(--gold-d);font-weight:700}
  .meta{font-size:.8rem;color:var(--muted);margin-top:5px}
  .amt{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-variant-numeric:tabular-nums}
  .acts{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}
  .acts a,.acts button{flex:1;min-width:88px;text-align:center;text-decoration:none;
    border-radius:9px;padding:11px 8px;font-weight:700;font-size:.85rem;border:1px solid var(--line);
    background:#fff;color:var(--navy2);cursor:pointer}
  .acts a.call{background:var(--navy);color:#fff;border-color:var(--navy)}
  .acts button.extras{background:var(--gold-d);color:#fff;border-color:var(--gold-d)}

  /* extras sheet */
  #sheet{position:fixed;inset:0;background:rgba(14,35,64,.55);display:none;
         align-items:flex-end;z-index:40}
  #sheet .inner{background:#fff;width:100%;border-radius:16px 16px 0 0;padding:20px 18px 26px;
                max-height:92vh;overflow:auto}
  #sheet h3{margin:0 0 4px;font-size:1.05rem}
  #sheet .sub{color:var(--muted);font-size:.85rem;margin-bottom:16px}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:.75rem;font-weight:700;color:var(--muted);
               text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
  .line{display:flex;justify-content:space-between;gap:14px;padding:9px 0;
        border-bottom:1px solid var(--line);font-size:.92rem}
  .line:last-of-type{border-bottom:0}
  .total{background:var(--bg);border-radius:10px;padding:13px 14px;margin:14px 0;
         display:flex;justify-content:space-between;align-items:center;font-weight:800}
  .total .n{font-size:1.3rem}

  /* time off */
  .blk{background:#fff;border:1px solid var(--line);border-radius:11px;padding:13px 14px;
       margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px}
  .blk .lbl{font-weight:700}
  .blk .rng{font-size:.82rem;color:var(--muted)}
  .blk button{border:none;background:none;color:var(--bad);font-weight:700;cursor:pointer;font-size:.85rem}

  /* customers + money */
  .crow{background:#fff;border:1px solid var(--line);border-radius:11px;padding:12px 14px;
        margin-bottom:9px;display:flex;justify-content:space-between;align-items:center;gap:10px}
  .crow .nm{font-weight:700}
  .crow .sm{font-size:.8rem;color:var(--muted)}
  .rides{background:var(--navy);color:#fff;border-radius:20px;font-size:.72rem;
         font-weight:800;padding:4px 10px;white-space:nowrap}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:11px;padding:14px}
  .stat .k{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:800}
  .stat .v{font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums;
           font-family:ui-monospace,Menlo,monospace;margin-top:3px}
  .hrow{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:.9rem}
  .hrow:last-child{border-bottom:0}
  .hrow .s{font-weight:700}
  .s.ok{color:var(--ok)} .s.bad{color:var(--bad)}

  /* nav */
  nav.tabs{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);
           display:flex;z-index:30;padding-bottom:env(safe-area-inset-bottom)}
  nav.tabs button{flex:1;border:none;background:none;padding:11px 4px 13px;color:var(--muted);
                  font-size:.68rem;font-weight:800;cursor:pointer;letter-spacing:.02em}
  nav.tabs button.active{color:var(--navy)}
  nav.tabs button .ic{display:block;margin:0 auto 3px;width:21px;height:21px}
  nav.tabs button .ic svg{width:21px;height:21px;display:block;
    stroke-linecap:round;stroke-linejoin:round}
  .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:92px;background:var(--navy);
         color:#fff;padding:12px 18px;border-radius:24px;font-weight:700;font-size:.88rem;
         z-index:60;display:none;max-width:90vw;text-align:center}

  /* ---------- calendar ---------- */
  .calbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 2px 12px}
  .calbar strong{font:600 .95rem/1 Inter,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)}
  .calnav{border:1px solid var(--line);background:#fff;color:var(--ink);width:38px;height:38px;
          border-radius:2px;font-size:1.2rem;line-height:1;cursor:pointer}
  .calgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);
           border:1px solid var(--line)}
  .calgrid .dow{background:#fff;color:var(--muted);font-size:.58rem;letter-spacing:.14em;
                text-transform:uppercase;text-align:center;padding:8px 0;font-weight:700}
  .cell{background:#fff;min-height:58px;padding:6px 5px;position:relative;cursor:pointer;
        display:flex;flex-direction:column;gap:4px}
  .cell.out{background:#fafbfc;color:var(--muted)}
  .cell .n{font-size:.76rem;font-weight:600;color:var(--ink)}
  .cell.out .n{color:#c3c9d1;font-weight:400}
  .cell.today .n{background:var(--metal);color:#fff;border-radius:50%;width:21px;height:21px;
                 display:inline-flex;align-items:center;justify-content:center;font-size:.7rem}
  .cell.sel{outline:2px solid var(--gold-d);outline-offset:-2px}
  .pip{height:3px;border-radius:2px;background:var(--gold-d)}
  .pip.off{background:#c3c9d1}
  .pip.due{background:#3d6b8f}
  .cell .more{font-size:.58rem;color:var(--muted)}

  /* ---------- invoices ---------- */
  .inv{background:#fff;border:1px solid var(--line);padding:14px;margin-bottom:9px;
       display:flex;justify-content:space-between;gap:12px;align-items:flex-start;cursor:pointer}
  .inv .who{font-weight:600;color:var(--ink)}
  .inv .meta{font-size:.76rem;color:var(--muted);margin-top:2px}
  .inv .amt{font:500 1.25rem/1 "Cormorant Garamond",Georgia,serif;color:var(--ink);white-space:nowrap}
  .pill{display:inline-block;font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;
        font-weight:700;padding:3px 7px;border-radius:2px;margin-top:6px}
  .pill.draft{background:#eef0f3;color:#5b6470}
  .pill.sent{background:#fdf3e2;color:var(--warn)}
  .pill.paid{background:var(--ok-bg);color:var(--ok)}
  .pill.void{background:#f6e9e9;color:var(--bad)}
  .fab{position:fixed;right:16px;bottom:90px;z-index:30;border:0;border-radius:2px;
       background:var(--metal);color:#fff;padding:15px 20px;font-weight:700;font-size:.72rem;
       letter-spacing:.14em;text-transform:uppercase;box-shadow:0 12px 30px -14px rgba(20,23,28,.6);cursor:pointer}
  .li{display:grid;grid-template-columns:1fr 52px 74px 30px;gap:7px;margin-bottom:8px;align-items:center}
  .li input{padding:10px}
  .li .x{border:0;background:none;color:var(--muted);font-size:1.1rem;cursor:pointer}
  .linkbox{display:flex;gap:8px;margin-top:10px}
  .linkbox input{font-size:.76rem;background:#f6f7f9}
  .invacts{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}
</style>
</head>
<body>

<div id="login">
  <div class="login-card">
    <h1>Amedeo's</h1>
    <div class="sub">Private Car Service</div>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password"/>
    <div class="err" id="loginErr"></div>
    <button class="btn block" id="loginBtn">Sign in</button>
  </div>
</div>

<div id="app">
  <header>
    <div class="brand">Amedeo's<small id="hdrSub">Private Car Service</small></div>
    <div class="dot" id="healthDot" title="System status"></div>
  </header>

  <section id="v-today" class="wrap"></section>
  <section id="v-calendar" class="wrap" style="display:none">
    <div class="calbar">
      <button class="calnav" id="calPrev">&#8249;</button>
      <strong id="calTitle">&nbsp;</strong>
      <button class="calnav" id="calNext">&#8250;</button>
    </div>
    <div class="calgrid" id="calGrid"></div>
    <div id="calDay"></div>
    <h2 class="day">Everything ahead</h2>
    <div id="v-upcoming"></div>
  </section>
  <section id="v-invoices" class="wrap" style="display:none"></section>
  <section id="v-timeoff" class="wrap" style="display:none"></section>
  <section id="v-more" class="wrap" style="display:none"></section>
</div>

<div id="sheet"><div class="inner" id="sheetInner"></div></div>
<div class="toast" id="toast"></div>

<nav class="tabs" id="tabs" style="display:none">
  <button class="active" data-v="v-today"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.8l6-.7z"/></svg></span>Today</button>
  <button data-v="v-calendar"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></svg></span>Calendar</button>
  <button data-v="v-invoices"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8.5h6M9 12.5h6"/></svg></span>Invoices</button>
  <button data-v="v-timeoff"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg></span>Time off</button>
  <button data-v="v-more"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7.5h16M4 12h16M4 16.5h16"/></svg></span>More</button>
</nav>

<script>
var S = { bookings: [], customers: [], blackouts: [], health: null };

function gid(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/[<>&"]/g, function(c){
  return {"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]; }); }

function api(path, opts){
  opts = opts || {};
  opts.credentials = "include";
  if (opts.body){ opts.headers = {"Content-Type":"application/json"}; opts.body = JSON.stringify(opts.body); }
  return fetch(path, opts).then(function(r){
    return r.json().then(function(j){ return {ok:r.ok, status:r.status, data:j}; })
                   .catch(function(){ return {ok:r.ok, status:r.status, data:{}}; });
  });
}

var toastTimer = null;
function toast(msg){
  var t = gid("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.style.display = "none"; }, 2600);
}

/* ---------- dates (all display is Florida local) ---------- */
var TZ = "America/New_York";
function localParts(ms){
  var f = new Intl.DateTimeFormat("en-US",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  var m = {}; f.formatToParts(new Date(ms)).forEach(function(p){ if(p.type!=="literal") m[p.type]=p.value; });
  return m.year + "-" + m.month + "-" + m.day;
}
function todayStr(){ return localParts(Date.now()); }
function tomorrowStr(){ return localParts(Date.now() + 86400000); }
function fmtTime(ms){
  return new Intl.DateTimeFormat("en-US",{timeZone:TZ,hour:"numeric",minute:"2-digit",hour12:true})
    .format(new Date(ms));
}
function fmtDay(ms){
  return new Intl.DateTimeFormat("en-US",{timeZone:TZ,weekday:"short",month:"short",day:"numeric"})
    .format(new Date(ms));
}

/* ---------- payment badge ---------- */
function payBadge(b){
  if (b.status === "canceled") return ['canceled','Canceled'];
  var p = b.payment_status;
  if (p === "charged")      return ['paid','Paid $' + Number(b.amount_charged||b.quoted_total||0).toFixed(0)];
  if (p === "failed")       return ['failed','Card failed'];
  if (p === "charging")     return ['pending','Charging…'];
  if (p === "refunded")     return ['canceled','Refunded'];
  if (p === "card_on_file") return ['pending','Charges T-24h'];
  return ['nocard','No card'];
}

/* ---------- ride card ---------- */
function rideCard(b, isNext){
  var d = document.createElement("div");
  d.className = "ride" + (isNext ? " next" : "");
  var bad = payBadge(b);
  var start = Number(b.ride_start_utc) || 0;

  var maps = "https://maps.google.com/?q=" + encodeURIComponent(b.pickup || "");
  var canExtras = b.payment_status === "charged" && b.status !== "canceled";

  d.innerHTML =
    '<div class="top">' +
      '<div><div class="time">' + (start ? esc(fmtTime(start)) : esc(b.ride_time||"")) + '</div>' +
      '<div class="date">' + (start ? esc(fmtDay(start)) : esc(b.ride_date||"")) + '</div></div>' +
      '<span class="badge ' + bad[0] + '">' + esc(bad[1]) + '</span>' +
    '</div>' +
    '<div class="who">' + esc(b.customer_name || "—") +
      (b.passengers ? ' <span class="meta">· ' + esc(b.passengers) + ' pax</span>' : '') + '</div>' +
    '<div class="route"><span class="pin">●</span> ' + esc(b.pickup || "—") +
      '<br/><span class="pin">◎</span> ' + esc(b.dropoff || "—") + '</div>' +
    (b.flight_number ? '<div class="meta">Flight ' + esc(b.flight_number) + '</div>' : '') +
    (b.notes ? '<div class="meta">' + esc(b.notes) + '</div>' : '') +
    (b.extras_total > 0 ? '<div class="meta">Extras charged: <span class="amt">$' +
      Number(b.extras_total).toFixed(2) + '</span>' + (b.extras_note ? ' — ' + esc(b.extras_note) : '') + '</div>' : '') +
    '<div class="acts">' +
      (b.customer_phone ? '<a class="call" href="tel:' + esc(b.customer_phone) + '">Call</a>' : '') +
      (b.customer_phone ? '<a href="sms:' + esc(b.customer_phone) + '">Text</a>' : '') +
      '<a href="' + esc(maps) + '" target="_blank" rel="noopener">Directions</a>' +
      (canExtras ? '<button class="extras" data-id="' + b.id + '">Add charges</button>' : '') +
    '</div>';

  var eb = d.querySelector("button.extras");
  if (eb) eb.onclick = function(){ openExtras(b); };
  return d;
}

/* ---------- views ---------- */
function activeRides(){
  return S.bookings.filter(function(b){ return b.status !== "canceled"; });
}

function renderToday(){
  var v = gid("v-today"); v.innerHTML = "";
  var t = todayStr(), tm = tomorrowStr();
  var today = [], tomorrow = [];
  activeRides().forEach(function(b){
    if (b.ride_date === t) today.push(b);
    else if (b.ride_date === tm) tomorrow.push(b);
  });
  var srt = function(a,b){ return (a.ride_start_utc||0) - (b.ride_start_utc||0); };
  today.sort(srt); tomorrow.sort(srt);

  var now = Date.now();
  var nextId = null;
  today.concat(tomorrow).some(function(b){
    if ((b.ride_start_utc||0) >= now){ nextId = b.id; return true; }
    return false;
  });

  if (!today.length && !tomorrow.length){
    v.innerHTML = '<div class="pad">Nothing booked today or tomorrow.<br/>Enjoy the quiet.</div>';
    return;
  }
  if (today.length){
    var h = document.createElement("h2"); h.className="day"; h.textContent="Today"; v.appendChild(h);
    today.forEach(function(b){ v.appendChild(rideCard(b, b.id===nextId)); });
  }
  if (tomorrow.length){
    var h2 = document.createElement("h2"); h2.className="day"; h2.textContent="Tomorrow"; v.appendChild(h2);
    tomorrow.forEach(function(b){ v.appendChild(rideCard(b, b.id===nextId)); });
  }
}

function renderUpcoming(){
  var v = gid("v-upcoming"); v.innerHTML = "";
  var t = todayStr();
  var future = activeRides().filter(function(b){ return (b.ride_date||"") > t; })
    .sort(function(a,b){ return (a.ride_start_utc||0) - (b.ride_start_utc||0); });

  if (!future.length){ v.innerHTML = '<div class="pad">No upcoming rides yet.</div>'; return; }
  var lastDay = "";
  future.forEach(function(b){
    if (b.ride_date !== lastDay){
      lastDay = b.ride_date;
      var h = document.createElement("h2"); h.className="day";
      h.textContent = b.ride_start_utc ? fmtDay(b.ride_start_utc) : b.ride_date;
      v.appendChild(h);
    }
    v.appendChild(rideCard(b, false));
  });
}

function renderTimeoff(){
  var v = gid("v-timeoff"); v.innerHTML = "";
  v.innerHTML =
    '<div class="ride"><div class="who" style="margin-top:0">Block time off</div>' +
    '<div class="meta" style="margin-bottom:12px">Nobody can book you on these days.</div>' +
    '<div class="field"><label>From</label><input type="date" id="boFrom"/></div>' +
    '<div class="field"><label>To (leave blank for one day)</label><input type="date" id="boTo"/></div>' +
    '<div class="field"><label>Reason (optional)</label><input type="text" id="boLabel" placeholder="Vacation"/></div>' +
    '<button class="btn block" id="boAdd">Block these dates</button></div>' +
    '<h2 class="day">Blocked</h2><div id="boList"></div>';

  gid("boAdd").onclick = function(){
    var from = gid("boFrom").value, to = gid("boTo").value, label = gid("boLabel").value;
    if (!from){ toast("Pick a start date"); return; }
    if (to && to < from){ toast("End date is before the start"); return; }
    api("/api/blackouts", {method:"POST", body:{from:from, to:to||from, label:label||"Unavailable"}})
      .then(function(r){
        if (r.ok){ toast("Dates blocked"); gid("boFrom").value=""; gid("boTo").value=""; gid("boLabel").value=""; loadBlackouts(); }
        else toast((r.data && r.data.error) || "Could not block those dates");
      });
  };

  var list = gid("boList");
  if (!S.blackouts.length){ list.innerHTML = '<div class="pad">No time off booked.</div>'; return; }
  S.blackouts.forEach(function(b){
    var row = document.createElement("div"); row.className = "blk";
    row.innerHTML = '<div><div class="lbl">' + esc(b.label||"Unavailable") + '</div>' +
                    '<div class="rng">' + esc(b.from) + (b.to && b.to!==b.from ? " → " + esc(b.to) : "") + '</div></div>';
    var del = document.createElement("button"); del.textContent = "Remove";
    del.onclick = function(){
      api("/api/blackouts/" + b.id, {method:"DELETE"}).then(function(){ toast("Removed"); loadBlackouts(); });
    };
    row.appendChild(del); list.appendChild(row);
  });
}

function renderMore(){
  var v = gid("v-more"); v.innerHTML = "";
  var rides = activeRides();
  var paid = rides.filter(function(b){ return b.payment_status === "charged"; });
  var revenue = paid.reduce(function(s,b){ return s + (Number(b.amount_charged)||0); }, 0);
  var problems = rides.filter(function(b){ return b.payment_status === "failed"; });
  var awaiting = rides.filter(function(b){ return b.payment_status === "card_on_file"; });

  var html =
    '<div class="stats">' +
      '<div class="stat"><div class="k">Collected</div><div class="v">$' + revenue.toFixed(0) + '</div></div>' +
      '<div class="stat"><div class="k">Rides paid</div><div class="v">' + paid.length + '</div></div>' +
      '<div class="stat"><div class="k">Awaiting charge</div><div class="v">' + awaiting.length + '</div></div>' +
      '<div class="stat"><div class="k">Card problems</div><div class="v" style="color:' +
        (problems.length ? "var(--bad)" : "inherit") + '">' + problems.length + '</div></div>' +
    '</div>';

  if (problems.length){
    html += '<h2 class="day">Needs attention</h2>';
    problems.forEach(function(b){
      html += '<div class="crow"><div><div class="nm">' + esc(b.customer_name||"—") + '</div>' +
              '<div class="sm">' + esc(b.ride_date||"") + ' · ' + esc(b.last_charge_error||"Card declined") + '</div></div>' +
              (b.customer_phone ? '<a class="rides" style="text-decoration:none" href="tel:' + esc(b.customer_phone) + '">Call</a>' : '') +
              '</div>';
    });
  }

  html += '<h2 class="day">System</h2><div class="ride" id="healthBox"><div class="pad">Checking…</div></div>' +
          '<button class="btn ghost block" id="runCharges" style="margin-bottom:10px">Run charge sweep now</button>' +
          '<h2 class="day">Customers</h2><div id="custList"></div>' +
          '<button class="btn ghost block" id="logoutBtn" style="margin-top:16px">Sign out</button>';
  v.innerHTML = html;

  gid("runCharges").onclick = function(){
    toast("Running…");
    api("/api/run-charges", {method:"POST"}).then(function(r){
      var d = r.data || {};
      toast("Charged " + (d.charged||0) + ", declined " + (d.declined||0));
      loadAll();
    });
  };
  gid("logoutBtn").onclick = function(){
    api("/admin/logout", {method:"POST"}).then(function(){ location.reload(); });
  };

  var cl = gid("custList");
  if (!S.customers.length){ cl.innerHTML = '<div class="pad">No customers yet.</div>'; }
  else S.customers.slice(0, 50).forEach(function(c){
    var row = document.createElement("div"); row.className = "crow";
    row.innerHTML = '<div><div class="nm">' + esc(c.name||"—") + '</div>' +
                    '<div class="sm">' + esc([c.phone, c.email].filter(Boolean).join("  ·  ")) + '</div></div>' +
                    '<span class="rides">' + (c.ride_count||0) + ' rides</span>';
    cl.appendChild(row);
  });

  renderHealth();
}

function renderHealth(){
  var box = gid("healthBox"); if (!box) return;
  var h = S.health;
  if (!h){ box.innerHTML = '<div class="pad">Checking…</div>'; return; }
  function row(k, ok, note){
    return '<div class="hrow"><span>' + esc(k) + '</span><span class="s ' + (ok?"ok":"bad") + '">' +
           esc(note || (ok ? "OK" : "Problem")) + '</span></div>';
  }
  var anet = h.authorizeNet || {};
  var anetOk = anet.configured && anet.ping && anet.ping.ok;
  box.innerHTML =
    row("Database", h.database, h.database ? h.rates + " rates loaded" : "Unreachable") +
    row("Payments", anetOk, anetOk ? (anet.mode === "production" ? "Live" : "Sandbox") : "Not connected") +
    row("Card form key", anet.clientKey, anet.clientKey ? "Set" : "MISSING") +
    row("Email", h.resend, h.resend ? "Ready" : "Not configured") +
    row("Text messages", h.twilio, h.twilio ? "Ready" : "Off");
  var dot = gid("healthDot");
  dot.className = "dot " + (h.database && anetOk && h.resend ? "ok" : "bad");
}

/* ---------- extras sheet ---------- */
var FEES = { waitPerMin: 1.25, extraStop: 20 };
function openExtras(b){
  var sheet = gid("sheet");
  gid("sheetInner").innerHTML =
    '<h3>Add charges</h3>' +
    '<div class="sub">' + esc(b.customer_name||"") + ' · ' + esc(b.ride_date||"") + '</div>' +
    '<div class="field"><label>Wait time (minutes past free)</label>' +
      '<input type="number" inputmode="numeric" id="exWait" min="0" step="1" placeholder="0"/></div>' +
    '<div class="field"><label>Tolls &amp; parking you paid ($)</label>' +
      '<input type="number" inputmode="decimal" id="exTolls" min="0" step="0.01" placeholder="0.00"/></div>' +
    '<div class="field"><label>Extra stops</label>' +
      '<input type="number" inputmode="numeric" id="exStops" min="0" step="1" placeholder="0"/></div>' +
    '<div class="total"><span>Charge to their card</span><span class="n" id="exTotal">$0.00</span></div>' +
    '<button class="btn block" id="exGo">Charge card</button>' +
    '<button class="btn ghost block" id="exCancel" style="margin-top:9px">Cancel</button>';
  sheet.style.display = "flex";

  function calc(){
    var w = Number(gid("exWait").value) || 0;
    var t = Number(gid("exTolls").value) || 0;
    var s = Number(gid("exStops").value) || 0;
    var total = w * FEES.waitPerMin + t + s * FEES.extraStop;
    gid("exTotal").textContent = "$" + total.toFixed(2);
    return total;
  }
  ["exWait","exTolls","exStops"].forEach(function(id){ gid(id).oninput = calc; });

  gid("exCancel").onclick = function(){ sheet.style.display = "none"; };
  gid("exGo").onclick = function(){
    var total = calc();
    if (total <= 0){ toast("Nothing to charge"); return; }
    var btn = gid("exGo"); btn.disabled = true; btn.textContent = "Charging…";
    api("/api/bookings/" + b.id + "/extras", {method:"POST", body:{
      waitMinutes: Number(gid("exWait").value)||0,
      tolls: Number(gid("exTolls").value)||0,
      extraStops: Number(gid("exStops").value)||0
    }}).then(function(r){
      btn.disabled = false; btn.textContent = "Charge card";
      if (r.ok){ sheet.style.display = "none"; toast("Charged $" + Number(r.data.amount).toFixed(2)); loadAll(); }
      else toast((r.data && r.data.error) || "Card declined");
    });
  };
}
gid("sheet").onclick = function(e){ if (e.target === gid("sheet")) gid("sheet").style.display = "none"; };

/* ---------- loading ---------- */
function loadAll(){ loadBookings(); loadCustomers(); loadBlackouts(); loadHealth(); }
function loadBookings(){
  api("/api/bookings").then(function(r){
    S.bookings = (r.data && r.data.bookings) || [];
    renderToday(); renderUpcoming();
    if (gid("v-more").style.display !== "none") renderMore();
  });
}
function loadCustomers(){
  api("/api/customers").then(function(r){ S.customers = (r.data && r.data.customers) || []; });
}
function loadBlackouts(){
  api("/api/blackouts").then(function(r){
    S.blackouts = (r.data && r.data.blackouts) || [];
    if (gid("v-timeoff").style.display !== "none") renderTimeoff();
  });
}
function loadHealth(){
  api("/api/health").then(function(r){ S.health = r.data || null; renderHealth(); });
}

/* ---------- auth + nav ---------- */
function enterApp(){
  gid("login").style.display = "none";
  gid("app").style.display = "block";
  gid("tabs").style.display = "flex";
  loadAll();
  setInterval(loadBookings, 120000);
}
function doLogin(){
  api("/admin/login", {method:"POST", body:{password: gid("pw").value}}).then(function(r){
    if (r.ok) enterApp(); else gid("loginErr").textContent = "Wrong password";
  });
}
function showView(id){
  ["v-today","v-calendar","v-invoices","v-timeoff","v-more"].forEach(function(v){
    gid(v).style.display = (v === id) ? "block" : "none";
  });
  var tb = document.querySelectorAll("nav.tabs button");
  for (var i=0;i<tb.length;i++) tb[i].classList.toggle("active", tb[i].getAttribute("data-v") === id);
  if (id === "v-calendar") { renderCalendar(); renderUpcoming(); }
  if (id === "v-invoices") loadInvoices();
  if (id === "v-timeoff") renderTimeoff();
  if (id === "v-more") renderMore();
  window.scrollTo(0,0);
}


/* ============================================================
   CALENDAR
   The month grid is the point of the whole tab: Matt needs to see
   at a glance which days are already spoken for before he says yes
   to someone on the phone. Pips, not text — a phone cell is 45px
   wide and a truncated pickup address tells him nothing.
   ============================================================ */
var CAL = { month: null, data: null, sel: null };

function monthKey(d){
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
}
function monthLabel(key){
  var p = key.split("-");
  var names = ["January","February","March","April","May","June","July",
               "August","September","October","November","December"];
  return names[Number(p[1])-1] + " " + p[0];
}
function shiftMonth(key, delta){
  var p = key.split("-");
  var d = new Date(Number(p[0]), Number(p[1]) - 1 + delta, 1);
  return monthKey(d);
}

function renderCalendar(){
  if (!CAL.month) CAL.month = todayStr().slice(0,7);
  gid("calTitle").textContent = monthLabel(CAL.month);
  api("/api/calendar?month=" + CAL.month).then(function(r){
    CAL.data = (r.ok && r.data) ? r.data : { bookings: [], blackouts: [], invoices: [] };
    paintCalendar();
  });
}

function paintCalendar(){
  var p = CAL.month.split("-");
  var year = Number(p[0]), mon = Number(p[1]) - 1;
  var first = new Date(year, mon, 1);
  var startDow = first.getDay();
  var daysIn = new Date(year, mon + 1, 0).getDate();
  var prevDays = new Date(year, mon, 0).getDate();

  var byDay = {};
  (CAL.data.bookings || []).forEach(function(b){
    (byDay[b.ride_date] = byDay[b.ride_date] || { rides: [], off: 0, due: [] }).rides.push(b);
  });
  (CAL.data.invoices || []).forEach(function(i){
    if (!i.due_date) return;
    (byDay[i.due_date] = byDay[i.due_date] || { rides: [], off: 0, due: [] }).due.push(i);
  });
  (CAL.data.blackouts || []).forEach(function(bo){
    var d = new Date(bo.start_utc);
    var end = new Date(bo.end_utc);
    for (var t = d.getTime(); t <= end.getTime(); t += 86400000){
      var key = localParts(t);
      (byDay[key] = byDay[key] || { rides: [], off: 0, due: [] }).off++;
    }
  });

  var html = ["S","M","T","W","T","F","S"].map(function(d){
    return '<div class="dow">' + d + '</div>';
  }).join("");

  var today = todayStr();
  function cell(dateStr, num, out){
    var d = byDay[dateStr] || { rides: [], off: 0, due: [] };
    var pips = "";
    var shown = Math.min(3, d.rides.length);
    for (var i = 0; i < shown; i++) pips += '<div class="pip"></div>';
    if (d.off) pips += '<div class="pip off"></div>';
    if (d.due.length) pips += '<div class="pip due"></div>';
    var extra = d.rides.length > 3 ? '<div class="more">+' + (d.rides.length - 3) + '</div>' : "";
    return '<div class="cell' + (out ? " out" : "") +
      (dateStr === today ? " today" : "") +
      (dateStr === CAL.sel ? " sel" : "") +
      '" data-d="' + dateStr + '"><span class="n">' + num + '</span>' + pips + extra + '</div>';
  }

  for (var i = startDow - 1; i >= 0; i--){
    var dnum = prevDays - i;
    var pm = shiftMonth(CAL.month, -1);
    html += cell(pm + "-" + String(dnum).padStart(2,"0"), dnum, true);
  }
  for (var day = 1; day <= daysIn; day++){
    html += cell(CAL.month + "-" + String(day).padStart(2,"0"), day, false);
  }
  var tail = (7 - ((startDow + daysIn) % 7)) % 7;
  for (var k = 1; k <= tail; k++){
    var nm = shiftMonth(CAL.month, 1);
    html += cell(nm + "-" + String(k).padStart(2,"0"), k, true);
  }

  gid("calGrid").innerHTML = html;
  var cells = gid("calGrid").querySelectorAll(".cell");
  for (var c = 0; c < cells.length; c++){
    (function(el){
      el.onclick = function(){ CAL.sel = el.getAttribute("data-d"); paintCalendar(); showDay(CAL.sel); };
    })(cells[c]);
  }
  if (CAL.sel) showDay(CAL.sel);
}

function showDay(dateStr){
  var rides = (CAL.data.bookings || []).filter(function(b){ return b.ride_date === dateStr; });
  var due = (CAL.data.invoices || []).filter(function(i){ return i.due_date === dateStr; });
  if (!rides.length && !due.length){
    gid("calDay").innerHTML = '<div class="pad">Nothing booked on ' + esc(dateStr) + '.</div>';
    return;
  }
  var html = '<h2 class="day">' + esc(dateStr) + '</h2>';
  rides.forEach(function(b){
    html += '<div class="inv"><div><div class="who">' + esc(b.ride_time || "") + ' &middot; ' +
      esc(b.customer_name || "Ride") + '</div><div class="meta">' +
      esc(b.pickup || "") + ' &rarr; ' + esc(b.dropoff || "") + '</div></div>' +
      '<div class="amt">$' + Number(b.quoted_total || 0).toFixed(0) + '</div></div>';
  });
  due.forEach(function(i){
    html += '<div class="inv"><div><div class="who">Invoice ' + esc(i.number) + ' due</div>' +
      '<div class="meta">' + esc(i.customer_name || "") + '</div></div>' +
      '<div class="amt">$' + Number(i.total || 0).toFixed(0) + '</div></div>';
  });
  gid("calDay").innerHTML = html;
}

/* ============================================================
   INVOICES
   ============================================================ */
var INV = { list: [] };

function loadInvoices(){
  api("/api/invoices").then(function(r){
    INV.list = (r.ok && r.data.invoices) ? r.data.invoices : [];
    renderInvoices();
  });
}

function renderInvoices(){
  var html = '<button class="fab" id="invNew">New invoice</button>';
  if (!INV.list.length){
    html += '<div class="pad">No invoices yet.<br/>Bill a corporate account, a wedding, or a no-show fee.</div>';
  } else {
    var open = INV.list.filter(function(i){ return i.status !== "paid" && i.status !== "void"; });
    var done = INV.list.filter(function(i){ return i.status === "paid" || i.status === "void"; });
    if (open.length){
      html += '<h2 class="day">Awaiting payment</h2>' + open.map(invRow).join("");
    }
    if (done.length){
      html += '<h2 class="day">Settled</h2>' + done.map(invRow).join("");
    }
  }
  gid("v-invoices").innerHTML = html;
  gid("invNew").onclick = openInvoiceComposer;
  var rows = gid("v-invoices").querySelectorAll(".inv");
  for (var i = 0; i < rows.length; i++){
    (function(el){
      el.onclick = function(){ openInvoice(Number(el.getAttribute("data-id"))); };
    })(rows[i]);
  }
}

function invRow(i){
  return '<div class="inv" data-id="' + i.id + '"><div>' +
    '<div class="who">' + esc(i.customer_name || "Customer") + '</div>' +
    '<div class="meta">' + esc(i.number) + (i.due_date ? ' &middot; due ' + esc(i.due_date) : "") + '</div>' +
    '<span class="pill ' + esc(i.status) + '">' + esc(i.status) + '</span>' +
    '</div><div class="amt">$' + Number(i.total || 0).toFixed(2) + '</div></div>';
}

function itemRow(){
  return '<div class="li">' +
    '<input placeholder="Airport transfer — PBI" class="ilabel"/>' +
    '<input inputmode="numeric" value="1" class="iqty"/>' +
    '<input inputmode="decimal" placeholder="0.00" class="iprice"/>' +
    '<button class="x" type="button">&times;</button></div>';
}

function openInvoiceComposer(){
  var sheet = gid("sheet");
  var opts = S.customers.map(function(c){
    return '<option value="' + c.id + '">' + esc(c.name) + (c.phone ? " · " + esc(c.phone) : "") + '</option>';
  }).join("");
  gid("sheetInner").innerHTML =
    '<h3>New invoice</h3>' +
    '<div class="field"><label>Existing customer</label>' +
      '<select id="ivCust"><option value="">— new person —</option>' + opts + '</select></div>' +
    '<div id="ivNewWrap">' +
      '<div class="field"><label>Name</label><input id="ivName"/></div>' +
      '<div class="field"><label>Email</label><input id="ivEmail" inputmode="email"/></div>' +
      '<div class="field"><label>Mobile</label><input id="ivPhone" inputmode="tel"/></div>' +
    '</div>' +
    '<div class="field"><label>Line items</label><div id="ivItems">' + itemRow() + '</div>' +
      '<button class="btn ghost block" type="button" id="ivAdd">Add line</button></div>' +
    '<div class="field"><label>Gratuity ($, optional)</label><input id="ivTip" inputmode="decimal" placeholder="0.00"/></div>' +
    '<div class="field"><label>Due date (optional)</label><input id="ivDue" type="date"/></div>' +
    '<div class="field"><label>Note to the customer</label><textarea id="ivNotes" rows="2"></textarea></div>' +
    '<div class="total"><span>Total</span><span class="n" id="ivTotal">$0.00</span></div>' +
    '<button class="btn block" id="ivSave">Create invoice</button>' +
    '<button class="btn ghost block" id="ivCancel" style="margin-top:9px">Cancel</button>';
  sheet.style.display = "flex";

  function wireRows(){
    var xs = gid("ivItems").querySelectorAll(".x");
    for (var i = 0; i < xs.length; i++){
      (function(b){
        b.onclick = function(){
          if (gid("ivItems").children.length > 1) b.parentNode.remove();
          calcTotal();
        };
      })(xs[i]);
    }
    var ins = gid("ivItems").querySelectorAll("input");
    for (var j = 0; j < ins.length; j++) ins[j].oninput = calcTotal;
  }
  function calcTotal(){
    var t = 0;
    var rows = gid("ivItems").children;
    for (var i = 0; i < rows.length; i++){
      var q = Number(rows[i].querySelector(".iqty").value) || 0;
      var pr = Number(rows[i].querySelector(".iprice").value) || 0;
      t += q * pr;
    }
    t += Number(gid("ivTip").value) || 0;
    gid("ivTotal").textContent = "$" + t.toFixed(2);
  }
  gid("ivTip").oninput = calcTotal;
  gid("ivAdd").onclick = function(){
    gid("ivItems").insertAdjacentHTML("beforeend", itemRow());
    wireRows();
  };
  gid("ivCust").onchange = function(){
    gid("ivNewWrap").style.display = gid("ivCust").value ? "none" : "block";
  };
  wireRows();

  gid("ivCancel").onclick = function(){ sheet.style.display = "none"; };
  gid("ivSave").onclick = function(){
    var items = [];
    var rows = gid("ivItems").children;
    for (var i = 0; i < rows.length; i++){
      var label = rows[i].querySelector(".ilabel").value.trim();
      if (!label) continue;
      items.push({
        label: label,
        qty: Number(rows[i].querySelector(".iqty").value) || 1,
        unitPrice: Number(rows[i].querySelector(".iprice").value) || 0
      });
    }
    if (!items.length){ toast("Add at least one line"); return; }
    var body = {
      customerId: gid("ivCust").value || null,
      name: gid("ivName") ? gid("ivName").value.trim() : "",
      email: gid("ivEmail") ? gid("ivEmail").value.trim() : "",
      phone: gid("ivPhone") ? gid("ivPhone").value.trim() : "",
      items: items,
      tip: Number(gid("ivTip").value) || 0,
      dueDate: gid("ivDue").value || null,
      notes: gid("ivNotes").value.trim() || null
    };
    var btn = gid("ivSave"); btn.disabled = true; btn.textContent = "Creating…";
    api("/api/invoices", { method: "POST", body: body }).then(function(r){
      btn.disabled = false; btn.textContent = "Create invoice";
      if (!r.ok){ toast((r.data && r.data.error) || "Could not create it"); return; }
      loadInvoices();
      openInvoiceDetail(r.data.invoice);
    });
  };
}

function openInvoice(id){
  api("/api/invoices/" + id).then(function(r){
    if (r.ok) openInvoiceDetail(r.data.invoice);
  });
}

function openInvoiceDetail(inv){
  var sheet = gid("sheet");
  var lines = (inv.items || []).map(function(it){
    return '<div class="line"><span>' + esc(it.label) +
      (it.qty > 1 ? ' &times; ' + it.qty : "") + '</span><span>$' +
      Number(it.amount).toFixed(2) + '</span></div>';
  }).join("");

  var link = inv.pay_url || "";
  var paid = inv.status === "paid";

  gid("sheetInner").innerHTML =
    '<h3>Invoice ' + esc(inv.number) + '</h3>' +
    '<div class="sub">' + esc(inv.customer_name || "") + '</div>' +
    lines +
    (inv.tip > 0 ? '<div class="line"><span>Gratuity</span><span>$' + Number(inv.tip).toFixed(2) + '</span></div>' : "") +
    '<div class="total"><span>Total</span><span class="n">$' + Number(inv.total).toFixed(2) + '</span></div>' +
    (paid
      ? '<div class="pad" style="padding:14px 0">Paid ' + esc((inv.paid_at || "").slice(0,10)) +
        (inv.card_last4 ? ' &middot; card ending ' + esc(inv.card_last4) : "") + '</div>'
      : '<div class="linkbox"><input id="ivLink" readonly value="' + esc(link) + '"/>' +
        '<button class="btn ghost" id="ivCopy">Copy</button></div>' +
        '<div class="invacts">' +
          '<button class="btn" id="ivEmail">Email link</button>' +
          '<button class="btn" id="ivSms">Text link</button>' +
        '</div>' +
        '<button class="btn ghost block" id="ivVoid" style="margin-top:9px">Void invoice</button>') +
    '<button class="btn ghost block" id="ivClose" style="margin-top:9px">Close</button>';
  sheet.style.display = "flex";

  gid("ivClose").onclick = function(){ sheet.style.display = "none"; };
  if (paid) return;

  gid("ivCopy").onclick = function(){
    var f = gid("ivLink");
    f.select(); f.setSelectionRange(0, 99999);
    if (navigator.clipboard) navigator.clipboard.writeText(f.value);
    else document.execCommand("copy");
    toast("Link copied");
  };

  gid("ivEmail").onclick = function(){
    var b = gid("ivEmail"); b.disabled = true; b.textContent = "Sending…";
    api("/api/invoices/" + inv.id + "/email", { method: "POST" }).then(function(r){
      b.disabled = false; b.textContent = "Email link";
      toast(r.ok ? "Emailed" : ((r.data && r.data.error) || "Email failed"));
      if (r.ok) loadInvoices();
    });
  };

  /* Text: if this business ever gets its own Twilio number the Worker
     sends it outright. Until then the Worker hands back an sms: URL and
     Matt's own Messages app opens with the text already written — the
     link goes out from the number his customers recognise. */
  gid("ivSms").onclick = function(){
    var b = gid("ivSms"); b.disabled = true; b.textContent = "…";
    api("/api/invoices/" + inv.id + "/sms", { method: "POST" }).then(function(r){
      b.disabled = false; b.textContent = "Text link";
      if (!r.ok){ toast((r.data && r.data.error) || "Could not text it"); return; }
      loadInvoices();
      if (r.data.mode === "sent"){ toast("Texted"); return; }
      toast("Opening Messages…");
      window.location.href = r.data.smsHref;
    });
  };

  gid("ivVoid").onclick = function(){
    api("/api/invoices/" + inv.id + "/void", { method: "POST" }).then(function(r){
      if (r.ok){ sheet.style.display = "none"; toast("Voided"); loadInvoices(); }
      else toast((r.data && r.data.error) || "Could not void it");
    });
  };
}

gid("loginBtn").onclick = doLogin;
gid("pw").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
var tbs = document.querySelectorAll("nav.tabs button");
for (var i=0;i<tbs.length;i++){
  (function(t){ t.onclick = function(){ showView(t.getAttribute("data-v")); }; })(tbs[i]);
}
gid("calPrev").onclick = function(){ CAL.month = shiftMonth(CAL.month || todayStr().slice(0,7), -1); CAL.sel = null; renderCalendar(); };
gid("calNext").onclick = function(){ CAL.month = shiftMonth(CAL.month || todayStr().slice(0,7), 1); CAL.sel = null; renderCalendar(); };

api("/api/me").then(function(r){ if (r.data && r.data.authed) enterApp(); });
</script>
</body>
</html>`;
