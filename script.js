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

  /* ---------- Reservation form ---------- */
  var form = document.getElementById("reserveForm");
  var success = document.getElementById("formSuccess");
  var newRequest = document.getElementById("newRequest");

  function showError(field, message) {
    var wrap = field.closest(".field");
    wrap.classList.add("invalid");
    var err = wrap.querySelector(".error");
    if (err) err.textContent = message;
  }
  function clearError(field) {
    var wrap = field.closest(".field");
    wrap.classList.remove("invalid");
    var err = wrap.querySelector(".error");
    if (err) err.textContent = "";
  }

  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var phoneRe = /[0-9]{7,}/; // at least 7 digits

  function validateField(field) {
    var val = (field.value || "").trim();
    if (field.hasAttribute("required") && !val) {
      showError(field, "This field is required.");
      return false;
    }
    if (field.type === "email" && val && !emailRe.test(val)) {
      showError(field, "Please enter a valid email address.");
      return false;
    }
    if (field.type === "tel" && val && !phoneRe.test(val.replace(/\D/g, ""))) {
      showError(field, "Please enter a valid phone number.");
      return false;
    }
    clearError(field);
    return true;
  }

  // Clear error as the user corrects a field
  form.querySelectorAll("input, select, textarea").forEach(function (field) {
    field.addEventListener("input", function () {
      if (field.closest(".field").classList.contains("invalid")) validateField(field);
    });
    field.addEventListener("change", function () {
      if (field.closest(".field").classList.contains("invalid")) validateField(field);
    });
  });

  // Reservation endpoint (Cloudflare Worker). Empty string = no backend yet,
  // in which case we just show the success state without sending.
  var RESERVE_ENDPOINT = "";

  function showSuccess() {
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var fields = form.querySelectorAll("input, select, textarea");
    var valid = true;
    var firstInvalid = null;

    fields.forEach(function (field) {
      if (!validateField(field)) {
        valid = false;
        if (!firstInvalid) firstInvalid = field;
      }
    });

    if (!valid) {
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    var submitBtn = form.querySelector('button[type="submit"]');

    // No backend configured — just show success.
    if (!RESERVE_ENDPOINT) { showSuccess(); return; }

    var payload = {};
    fields.forEach(function (field) { if (field.name) payload[field.name] = field.value; });

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Sending…"; }

    fetch(RESERVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed");
        return res.json();
      })
      .then(function () { showSuccess(); })
      .catch(function () {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Request Reservation"; }
        alert("Sorry — something went wrong sending your request. Please call 848-667-0999 and we'll take care of you right away.");
      });
  });

  if (newRequest) {
    newRequest.addEventListener("click", function () {
      form.reset();
      form.querySelectorAll(".field.invalid").forEach(function (w) {
        w.classList.remove("invalid");
        var err = w.querySelector(".error");
        if (err) err.textContent = "";
      });
      success.hidden = true;
      form.hidden = false;
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  /* ---------- Prevent past dates on the date picker ---------- */
  var dateInput = document.getElementById("date");
  if (dateInput) {
    var today = new Date();
    var iso = today.getFullYear() + "-" +
      String(today.getMonth() + 1).padStart(2, "0") + "-" +
      String(today.getDate()).padStart(2, "0");
    dateInput.min = iso;
  }
})();
