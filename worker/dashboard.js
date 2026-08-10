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
<meta name="theme-color" content="#0e2340"/>
<title>Amedeo's</title>
<style>
  :root{--navy:#0e2340;--navy2:#16335c;--gold:#c4a253;--gold-d:#a8801f;
        --ink:#1b2533;--muted:#7b8597;--line:#e3e8ef;--bg:#f4f6f9;
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
  nav.tabs button .ic{display:block;font-size:1.15rem;margin-bottom:1px}
  .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:92px;background:var(--navy);
         color:#fff;padding:12px 18px;border-radius:24px;font-weight:700;font-size:.88rem;
         z-index:60;display:none;max-width:90vw;text-align:center}
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
  <section id="v-upcoming" class="wrap" style="display:none"></section>
  <section id="v-timeoff" class="wrap" style="display:none"></section>
  <section id="v-more" class="wrap" style="display:none"></section>
</div>

<div id="sheet"><div class="inner" id="sheetInner"></div></div>
<div class="toast" id="toast"></div>

<nav class="tabs" id="tabs" style="display:none">
  <button class="active" data-v="v-today"><span class="ic">&#9733;</span>Today</button>
  <button data-v="v-upcoming"><span class="ic">&#128197;</span>Upcoming</button>
  <button data-v="v-timeoff"><span class="ic">&#9209;</span>Time off</button>
  <button data-v="v-more"><span class="ic">&#9776;</span>More</button>
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
  ["v-today","v-upcoming","v-timeoff","v-more"].forEach(function(v){
    gid(v).style.display = (v === id) ? "block" : "none";
  });
  var tb = document.querySelectorAll("nav.tabs button");
  for (var i=0;i<tb.length;i++) tb[i].classList.toggle("active", tb[i].getAttribute("data-v") === id);
  if (id === "v-timeoff") renderTimeoff();
  if (id === "v-more") renderMore();
  window.scrollTo(0,0);
}

gid("loginBtn").onclick = doLogin;
gid("pw").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
var tbs = document.querySelectorAll("nav.tabs button");
for (var i=0;i<tbs.length;i++){
  (function(t){ t.onclick = function(){ showView(t.getAttribute("data-v")); }; })(tbs[i]);
}
api("/api/me").then(function(r){ if (r.data && r.data.authed) enterApp(); });
</script>
</body>
</html>`;
