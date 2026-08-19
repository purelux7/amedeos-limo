/* ============================================================
   The customer-facing payment page, served at /pay/<token>.

   Self-contained: no build step, no framework, one file. It is the
   only page a customer sees after Matt texts or emails a link, so it
   carries the same sterile-silver identity as the site itself and
   says out loud that the card goes to Authorize.net, not to us.

   The card number is tokenised in the browser by Accept.js and this
   page only ever forwards the resulting one-time opaque token. No
   PAN is posted to the Worker, logged, or stored.
   ============================================================ */

export const PAY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Pay your invoice · Amedeo's Private Car Service</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#f6f7f9;--panel:#fff;--ink:#14171c;--body:#5b6470;--muted:#8a929d;
  --line:#e6e8ec;--line2:#d3d7dd;--gold:#8a6d2f;--gold2:#c8a961;
  --metal:linear-gradient(135deg,#e0c894 0%,#a8873f 34%,#8a6d2f 58%,#d6bd84 100%);
  --bad:#b03a3a;--ok:#1f7a4d;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:400 15px/1.6 Inter,system-ui,sans-serif;
     -webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:40px 20px 60px}
.brand{text-align:center;margin-bottom:34px}
.brand b{font:600 1.7rem/1 "Cormorant Garamond",Georgia,serif;color:var(--ink);display:block}
.brand span{display:block;margin-top:6px;font-size:.54rem;text-transform:uppercase;
            letter-spacing:.32em;color:var(--gold);font-weight:600}
.card{background:var(--panel);border:1px solid var(--line);box-shadow:0 18px 44px -30px rgba(20,23,28,.35)}
.card+.card{margin-top:18px}
.pad{padding:28px 26px}
.eyebrow{font-size:.62rem;text-transform:uppercase;letter-spacing:.28em;color:var(--gold);font-weight:600}
h1{font:500 2rem/1.1 "Cormorant Garamond",Georgia,serif;color:var(--ink);margin:10px 0 2px}
.rule{height:1px;background:var(--line);margin:22px 0}
.line{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.line:last-of-type{border-bottom:0}
.line .l{color:var(--ink)}
.line .q{color:var(--muted)}
.total{display:flex;justify-content:space-between;align-items:baseline;padding-top:18px;margin-top:6px;
       border-top:2px solid var(--ink)}
.total .l{font-weight:600;color:var(--ink);text-transform:uppercase;letter-spacing:.14em;font-size:.72rem}
.total .v{font:500 2rem/1 "Cormorant Garamond",Georgia,serif;color:var(--ink)}
label{display:block;font-size:.68rem;text-transform:uppercase;letter-spacing:.14em;
      color:var(--muted);font-weight:600;margin:0 0 7px}
input{font:inherit;width:100%;padding:13px 14px;border:1px solid var(--line2);border-radius:2px;
      background:#fff;color:var(--ink)}
input:focus{outline:none;border-color:var(--gold)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{margin-bottom:16px}
.btn{width:100%;border:0;border-radius:2px;padding:17px;background:var(--metal);color:#fff;
     font:600 .74rem/1 Inter,sans-serif;text-transform:uppercase;letter-spacing:.16em;cursor:pointer;
     position:relative;overflow:hidden}
.btn[disabled]{opacity:.55;cursor:default}
.note{font-size:.78rem;color:var(--muted);text-align:center;margin-top:14px}
.err{color:var(--bad);font-size:.88rem;margin-top:12px;min-height:1em}
.paid{text-align:center;padding:44px 26px}
.paid .tick{width:54px;height:54px;border:1px solid var(--gold);border-radius:50%;margin:0 auto 18px;
            display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:1.4rem}
.paid h2{font:500 1.7rem/1.2 "Cormorant Garamond",Georgia,serif;color:var(--ink);margin:0 0 6px}
.skel{color:var(--muted);text-align:center;padding:50px 0}
.foot{text-align:center;color:var(--muted);font-size:.74rem;margin-top:26px;line-height:1.9}
.foot a{color:var(--gold);text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><b>Amedeo's</b><span>Private Car Service</span></div>
  <div id="view" class="card"><div class="skel">Loading your invoice…</div></div>
  <p class="foot">
    Card details are sent directly to Authorize.net.<br/>
    This page never sees or stores your card number.<br/>
    Questions? <a href="tel:+18486670999">848-667-0999</a>
  </p>
</div>

<script>
(function(){
  "use strict";
  var token = location.pathname.split("/").filter(Boolean).pop();
  var view = document.getElementById("view");
  var data = null;

  function esc(s){return String(s==null?"":s).replace(/[<>&"]/g,function(c){
    return {"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c];});}
  function money(n){return (Math.round((Number(n)||0)*100)/100).toFixed(2);}

  function paidView(inv){
    view.innerHTML = '<div class="paid"><div class="tick">&#10003;</div>' +
      '<h2>Paid in full</h2><p>Invoice ' + esc(inv.number) + ' &middot; $' + money(inv.total) +
      (inv.cardLast4 ? ' &middot; card ending ' + esc(inv.cardLast4) : '') + '</p>' +
      '<p style="color:#8a929d;font-size:.85rem">A receipt has been emailed to you.</p></div>';
  }

  function render(){
    var inv = data.invoice;
    if (inv.status === "paid") return paidView(inv);

    var rows = inv.items.map(function(it){
      return '<div class="line"><span class="l">' + esc(it.label) +
        (it.qty > 1 ? ' <span class="q">&times; ' + it.qty + '</span>' : '') +
        '</span><span>$' + money(it.amount) + '</span></div>';
    }).join("");

    if (inv.tip > 0) {
      rows += '<div class="line"><span class="l">Gratuity</span><span>$' + money(inv.tip) + '</span></div>';
    }

    view.innerHTML =
      '<div class="pad">' +
        '<p class="eyebrow">Invoice ' + esc(inv.number) + '</p>' +
        '<h1>Amount due</h1>' +
        '<div class="rule"></div>' + rows +
        '<div class="total"><span class="l">Total</span><span class="v">$' + money(inv.total) + '</span></div>' +
        (inv.notes ? '<p style="margin-top:18px;font-size:.9rem">' + esc(inv.notes) + '</p>' : '') +
      '</div>' +
      '<div class="pad" style="border-top:1px solid var(--line)">' +
        '<p class="eyebrow" style="margin-bottom:18px">Card details</p>' +
        '<div class="field"><label for="cc">Card number</label>' +
          '<input id="cc" inputmode="numeric" autocomplete="cc-number" maxlength="23" placeholder="&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull;"/></div>' +
        '<div class="grid">' +
          '<div class="field"><label for="exp">Expiry</label><input id="exp" inputmode="numeric" autocomplete="cc-exp" maxlength="5" placeholder="09/29"/></div>' +
          '<div class="field"><label for="cvv">CVV</label><input id="cvv" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="123"/></div>' +
        '</div>' +
        '<div class="field"><label for="zip">Billing ZIP</label><input id="zip" inputmode="numeric" maxlength="10" autocomplete="postal-code"/></div>' +
        '<button class="btn" id="pay">Pay $' + money(inv.total) + '</button>' +
        '<p class="err" id="err"></p>' +
        '<p class="note">Secure payment &middot; Authorize.net</p>' +
      '</div>';

    document.getElementById("cc").addEventListener("input", function(e){
      var v = e.target.value.replace(/\\D/g,"").slice(0,19);
      e.target.value = v.replace(/(.{4})/g,"$1 ").trim();
    });
    document.getElementById("exp").addEventListener("input", function(e){
      var v = e.target.value.replace(/\\D/g,"").slice(0,4);
      e.target.value = v.length > 2 ? v.slice(0,2) + "/" + v.slice(2) : v;
    });
    document.getElementById("pay").addEventListener("click", pay);
  }

  function fail(msg){
    var e = document.getElementById("err");
    if (e) e.textContent = msg;
    var b = document.getElementById("pay");
    if (b) { b.disabled = false; b.textContent = "Pay $" + money(data.invoice.total); }
  }

  function pay(){
    var btn = document.getElementById("pay");
    btn.disabled = true; btn.textContent = "Processing…";
    document.getElementById("err").textContent = "";

    var num = document.getElementById("cc").value.replace(/\\s/g,"");
    var exp = document.getElementById("exp").value.split("/");
    var cvv = document.getElementById("cvv").value.trim();
    var zip = document.getElementById("zip").value.trim();

    if (num.length < 13) return fail("Please check the card number.");
    if (exp.length !== 2 || exp[0].length !== 2) return fail("Please check the expiry date.");
    if (cvv.length < 3) return fail("Please check the CVV.");
    if (!/^\d{5}(-?\d{4})?$/.test(zip)) return fail("Enter the billing ZIP for this card.");

    if (!window.Accept || !data.payments.enabled) {
      return fail("Card payments are unavailable. Please call 848-667-0999.");
    }

    window.Accept.dispatchData({
      authData: {
        clientKey: data.payments.clientKey,
        apiLoginID: data.payments.apiLoginId
      },
      cardData: {
        cardNumber: num,
        month: exp[0],
        year: exp[1].length === 2 ? "20" + exp[1] : exp[1],
        cardCode: cvv,
        zip: zip
      }
    }, function(res){
      if (res.messages.resultCode !== "Ok") {
        return fail("That card could not be verified. Please check the details.");
      }
      fetch("/api/pay/" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opaqueData: res.opaqueData, zip: zip })
      }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(out){
          if (!out.ok) return fail(out.j.error || "The payment did not go through.");
          data.invoice.status = "paid";
          data.invoice.cardLast4 = out.j.last4;
          paidView(data.invoice);
          window.scrollTo(0,0);
        })
        .catch(function(){ fail("We couldn't reach the payment system. Please call 848-667-0999."); });
    });
  }

  function loadAccept(mode){
    var s = document.createElement("script");
    s.src = mode === "production"
      ? "https://js.authorize.net/v1/Accept.js"
      : "https://jstest.authorize.net/v1/Accept.js";
    s.async = true;
    document.head.appendChild(s);
  }

  fetch("/api/pay/" + encodeURIComponent(token))
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
    .then(function(out){
      if (!out.ok) {
        view.innerHTML = '<div class="paid"><h2>Link not valid</h2><p>' +
          esc(out.j.error || "This payment link is no longer valid.") +
          '</p><p style="font-size:.85rem">Call 848-667-0999 and we will send a new one.</p></div>';
        return;
      }
      data = out.j;
      if (data.payments.enabled) loadAccept(data.payments.mode);
      render();
    })
    .catch(function(){
      view.innerHTML = '<div class="paid"><h2>Something went wrong</h2>' +
        '<p>Please call 848-667-0999.</p></div>';
    });
})();
</script>
</body>
</html>`;
