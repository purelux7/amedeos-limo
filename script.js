/* ============================================================
   Amedeo's Limo Service — interactions
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Current year ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Header scroll state ---------- */
  var header = document.getElementById("siteHeader");
  function onScroll() {
    if (window.scrollY > 30) header.classList.add("scrolled");
    else header.classList.remove("scrolled");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile menu ---------- */
  var navToggle = document.getElementById("navToggle");
  var mobileMenu = document.getElementById("mobileMenu");

  function setMenu(open) {
    mobileMenu.classList.toggle("open", open);
    mobileMenu.setAttribute("aria-hidden", String(!open));
    navToggle.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  }
  navToggle.addEventListener("click", function () {
    setMenu(!mobileMenu.classList.contains("open"));
  });
  mobileMenu.querySelectorAll("a").forEach(function (link) {
    link.addEventListener("click", function () { setMenu(false); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && mobileMenu.classList.contains("open")) setMenu(false);
  });

  /* ---------- Fade-in on scroll ---------- */
  var faders = document.querySelectorAll(".fade-in");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    faders.forEach(function (el) { io.observe(el); });
  } else {
    faders.forEach(function (el) { el.classList.add("visible"); });
  }

  /* ---------- FAQ: single-open accordion ---------- */
  var faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (item.open) {
        faqItems.forEach(function (other) {
          if (other !== item) other.open = false;
        });
      }
    });
  });

  /* ============================================================
     Booking — live quote, availability, and card capture.

     The card fields deliberately have NO name attribute and are never
     put in the payload. Accept.js hands the card straight to
     Authorize.net and returns a one-time nonce; that nonce is all our
     server ever receives.
     ============================================================ */

  // Point at a local `wrangler dev` when browsing from localhost, so the
  // whole booking flow can be exercised before anything is deployed.
  // window.AFACS_API lets a dev harness point the form at a local worker on the
  // same origin. Production never sets it, so the constant below is used.
  var API = (typeof window.AFACS_API === "string")
    ? window.AFACS_API
    : (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
        ? location.protocol + "//" + location.hostname + ":8787"
        : "https://api.allfloridaairportscarservice.com");
  var form = document.getElementById("reserveForm");
  var success = document.getElementById("formSuccess");

  if (form) {
    var CFG = null, AVAIL = null, busy = false;

    function $(id) { return document.getElementById(id); }
    function val(id) { var el = $(id); return el ? (el.value || "").trim() : ""; }
    function money(n) { return "$" + Number(n).toFixed(2); }

    function showError(field, message) {
      var wrap = field.closest(".field");
      if (!wrap) return;
      wrap.classList.add("invalid");
      var err = wrap.querySelector(".error");
      if (err) err.textContent = message;
    }
    function clearError(field) {
      var wrap = field.closest(".field");
      if (!wrap) return;
      wrap.classList.remove("invalid");
      var err = wrap.querySelector(".error");
      if (err) err.textContent = "";
    }
    function formError(msg) {
      var box = $("formError");
      if (!box) return;
      if (msg) { box.textContent = msg; box.hidden = false; }
      else { box.textContent = ""; box.hidden = true; }
    }

    /* ---------- load rates + payment config ---------- */
    fetch(API + "/api/config")
      .then(function (r) { return r.json(); })
      .then(function (c) {
        CFG = c;
        var sel = $("dest");
        sel.innerHTML = '<option value="" disabled selected>Choose a destination…</option>';
        (c.rates || []).forEach(function (r) {
          var o = document.createElement("option");
          o.value = r.code;
          o.textContent = r.label + (r.code === "HOURLY" ? "" : " — " + money(r.price));
          sel.appendChild(o);
        });

        var h = $("hours");
        if (h) {
          for (var i = 3; i <= 12; i++) {
            var o = document.createElement("option");
            o.value = i; o.textContent = i + " hours";
            h.appendChild(o);
          }
        }

        var lead = (c.minLeadHours || 3) * 3600000;
        var earliest = new Date(Date.now() + lead);
        $("date").min = earliest.getFullYear() + "-" +
          String(earliest.getMonth() + 1).padStart(2, "0") + "-" +
          String(earliest.getDate()).padStart(2, "0");

        if (!c.payments || !c.payments.enabled) {
          formError("Online booking is temporarily unavailable. Please call 848-667-0999 and we'll take care of you.");
          $("submitBtn").disabled = true;
        }
      })
      .catch(function () {
        $("dest").innerHTML = '<option value="" disabled selected>Could not load rates — please call</option>';
        formError("We couldn't load our rates. Please call 848-667-0999.");
      });

    /* ---------- live quote ---------- */
    var quoteTimer = null;
    function requestQuote() { clearTimeout(quoteTimer); quoteTimer = setTimeout(doQuote, 250); }

    function doQuote() {
      var dest = val("dest");
      var panel = $("quotePanel");
      if (!dest) { panel.hidden = true; AVAIL = null; return; }

      var body = { destCode: dest, date: val("date") || null, time: val("time") || null };
      if (dest === "HOURLY") body.hours = Number(val("hours")) || 3;

      fetch(API + "/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) { panel.hidden = true; return; }
          AVAIL = j.availability;
          if (j.chargeOn) $("chargeWhen").textContent = "on " + j.chargeOn;
          renderQuote(j);
        })
        .catch(function () { panel.hidden = true; });
    }

    function renderQuote(j) {
      var q = j.quote, panel = $("quotePanel");
      var html =
        '<div class="q-line"><span>' + q.label + '</span><span>' + money(q.base) + '</span></div>' +
        '<div class="q-line"><span>Gratuity (' + q.gratuityPct + '%)</span><span>' + money(q.gratuity) + '</span></div>' +
        '<div class="q-line q-total"><span>Total</span><span>' + money(q.total) + '</span></div>';

      if (j.availability) {
        if (j.availability.available) {
          html += '<div class="q-avail is-open">&#10003; That time is available</div>';
        } else {
          html += '<div class="q-avail is-busy">' + j.availability.reason + '</div>';
          if (j.alternatives && j.alternatives.length) {
            html += '<div class="q-alts">';
            j.alternatives.forEach(function (a) {
              html += '<button type="button" data-t="' + a.time + '">' +
                      a.pretty.replace(/^[^,]*,\s*/, "") + '</button>';
            });
            html += '</div>';
          }
        }
      }
      html += '<p class="q-note">Tolls and airport parking are added at cost after your ride. ' +
              'Nothing is charged today.</p>';

      panel.innerHTML = html;
      panel.hidden = false;

      Array.prototype.forEach.call(panel.querySelectorAll(".q-alts button"), function (b) {
        b.addEventListener("click", function () {
          $("time").value = b.getAttribute("data-t");
          requestQuote();
        });
      });
    }

    ["dest", "date", "time", "hours"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () {
        if (id === "dest") $("hoursWrap").hidden = val("dest") !== "HOURLY";
        clearError(el);
        requestQuote();
      });
    });

    /* ---------- card field formatting ---------- */
    $("cc").addEventListener("input", function (e) {
      var v = e.target.value.replace(/\D/g, "").slice(0, 19);
      e.target.value = v.replace(/(.{4})/g, "$1 ").trim();
      clearError(e.target);
    });
    $("exp").addEventListener("input", function (e) {
      var v = e.target.value.replace(/\D/g, "").slice(0, 4);
      e.target.value = v.length > 2 ? v.slice(0, 2) + "/" + v.slice(2) : v;
      clearError(e.target);
    });
    $("cvv").addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
      clearError(e.target);
    });

    form.querySelectorAll("input, select, textarea").forEach(function (field) {
      field.addEventListener("input", function () {
        var w = field.closest(".field");
        if (w && w.classList.contains("invalid") && (field.value || "").trim()) clearError(field);
      });
    });

    /* ---------- validation ---------- */
    var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function validate() {
      var okAll = true, first = null;
      function bad(id, msg) {
        var el = $(id);
        showError(el, msg);
        okAll = false;
        if (!first) first = el;
      }

      [["dest", "Please choose a destination."],
       ["pickup", "Where should we collect you?"],
       ["dropoff", "Where are you going?"],
       ["date", "Pick a date."],
       ["time", "Pick a pickup time."],
       ["passengers", "How many passengers?"],
       ["name", "Please enter your name."],
       ["phone", "We need a number to reach you."],
       ["email", "Please enter your email."]
      ].forEach(function (p) {
        if (!val(p[0])) bad(p[0], p[1]); else clearError($(p[0]));
      });

      if (val("email") && !emailRe.test(val("email"))) bad("email", "That email doesn't look right.");
      if (val("phone") && val("phone").replace(/\D/g, "").length < 7) bad("phone", "That number looks too short.");

      if (val("cc").replace(/\s/g, "").length < 13) bad("cc", "Please enter your card number.");
      else clearError($("cc"));
      if (!/^\d{2}\/\d{2}$/.test(val("exp"))) bad("exp", "MM/YY");
      else clearError($("exp"));
      if (val("cvv").length < 3) bad("cvv", "3 or 4 digits.");
      else clearError($("cvv"));
      if (!val("zip")) bad("zip", "Your card's billing ZIP.");
      else clearError($("zip"));

      if (!$("terms").checked) {
        formError("Please agree to the terms and card authorization to continue.");
        okAll = false;
        if (!first) first = $("terms");
      }
      if (AVAIL && !AVAIL.available) {
        formError("That pickup time isn't available. Please choose another.");
        okAll = false;
        if (!first) first = $("time");
      }

      if (first) first.focus({ preventScroll: false });
      return okAll;
    }

    /* ---------- submit ---------- */
    function reset(label) {
      busy = false;
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = label || "Confirm Booking";
    }

    function cardMessage(code, text) {
      var s = String(code) + " " + String(text);
      // E_WC_02 means the page is not on HTTPS, so Accept.js refused to run.
      // That is a site configuration fault, never the customer's card — saying
      // "check your card" would send them chasing a problem that isn't theirs.
      if (/E_WC_02|HTTPS/i.test(s)) {
        return "Secure payment couldn't start on this page. Please call 848-667-0999 — this is our fault, not your card.";
      }
      if (/E_WC_01|E_WC_03|E_WC_04|authentication/i.test(s)) {
        return "Our payment system isn't responding. Please call 848-667-0999 and we'll book you right away.";
      }
      if (/E_WC_05|card number/i.test(s)) return "That card number doesn't look right. Please check it.";
      if (/E_WC_06|E_WC_07|E_WC_08|expir/i.test(s)) return "Please check the expiry date.";
      if (/E_WC_15|E_WC_16|security code/i.test(s)) return "Please check the CVV.";
      if (/E_WC_17|E_WC_18|zip/i.test(s)) return "Please check the billing ZIP.";
      return "We couldn't verify that card. Please check the details and try again.";
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;
      formError("");
      if (!validate()) return;
      if (!CFG || !CFG.payments || !CFG.payments.enabled) {
        formError("Online booking is temporarily unavailable. Please call 848-667-0999.");
        return;
      }

      busy = true;
      $("submitBtn").disabled = true;
      $("submitBtn").textContent = "Securing your card…";

      var exp = val("exp").split("/");
      Accept.dispatchData({
        authData: { clientKey: CFG.payments.clientKey, apiLoginID: CFG.payments.apiLoginId },
        cardData: {
          cardNumber: val("cc").replace(/\s/g, ""),
          month: exp[0],
          year: exp[1],
          cardCode: val("cvv"),
          zip: val("zip")
        }
      }, function (resp) {
        if (!resp || !resp.messages || resp.messages.resultCode !== "Ok") {
          var m = (resp && resp.messages && resp.messages.message && resp.messages.message[0]) || {};
          reset();
          formError(cardMessage(m.code, m.text));
          return;
        }
        sendBooking(resp.opaqueData);
      });
    });

    function sendBooking(opaque) {
      $("submitBtn").textContent = "Confirming…";

      var payload = {
        destCode: val("dest"),
        pickup: val("pickup"),
        dropoff: val("dropoff"),
        date: val("date"),
        time: val("time"),
        passengers: val("passengers"),
        flightNumber: val("flight") || null,
        notes: val("notes"),
        name: val("name"),
        phone: val("phone"),
        email: val("email"),
        billingZip: val("zip"),
        termsAccepted: true,
        company: val("company"),
        opaqueDataDescriptor: opaque.dataDescriptor,
        opaqueDataValue: opaque.dataValue
      };
      if (val("dest") === "HOURLY") payload.hours = Number(val("hours")) || 3;

      var controller = ("AbortController" in window) ? new AbortController() : null;
      var timedOut = false;
      var timer = setTimeout(function () {
        timedOut = true;
        if (controller) controller.abort();
      }, 25000);

      fetch(API + "/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      })
        .then(function (res) {
          clearTimeout(timer);
          return res.json().then(function (j) { return { ok: res.ok, j: j }; });
        })
        .then(function (out) {
          if (!out.ok) {
            reset();
            var msg = out.j.error || "Something went wrong. Please call 848-667-0999.";
            if (out.j.alternatives && out.j.alternatives.length) {
              msg += " Try: " + out.j.alternatives.map(function (a) { return a.pretty; }).join(", ") + ".";
            }
            formError(msg);
            return;
          }
          showBooked(out.j, payload);
        })
        .catch(function () {
          clearTimeout(timer);
          reset();
          formError(timedOut
            ? "That took longer than expected. Please call 848-667-0999 before trying again — do not re-enter your card."
            : "We couldn't reach the booking system. Please call 848-667-0999.");
        });
    }

    function showBooked(j, payload) {
      var rows = [
        ["Pickup", payload.date + " at " + payload.time],
        ["From", payload.pickup],
        ["To", payload.dropoff],
        ["Flat rate", money(j.quote.base)],
        ["Gratuity", money(j.quote.gratuity)],
        ["Total", money(j.quote.total)],
        ["Charged today", "$0.00"],
        ["Card charges", j.chargeOn || "the day before your ride"]
      ];
      if (j.card) rows.push(["Card on file", j.card.brand + " ending " + j.card.last4]);

      document.getElementById("successSub").textContent =
        "Your ride is confirmed. A confirmation is on its way to " + payload.email + ".";
      document.getElementById("successRecap").innerHTML = rows.map(function (r) {
        return '<div class="r"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
      }).join("");
      var link = document.getElementById("manageLink");
      if (j.manageUrl) link.href = j.manageUrl; else link.hidden = true;

      form.hidden = true;
      success.hidden = false;
      success.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

})();
