/* ============================================================
   Motion layer — the PureLux "atelier" feel, adapted for a car service.

   What was borrowed: slow, weighted reveals; type that rises into place
   from behind a mask; a hero that drifts as you scroll; deep restraint.

   What was deliberately NOT borrowed: scroll hijacking. PureLux walks
   you through rooms before you reach anything. Someone booking a 5am
   airport ride at 11pm needs the form immediately, and gating it behind
   an experience is exactly what bounced ~91% of PureLux's ad traffic.
   Everything here decorates the scroll; nothing intercepts it.

   Native scrolling, no libraries, no framework. Reduced-motion users get
   the finished state instantly with no animation at all.
   ============================================================ */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.documentElement;
  root.classList.add("motion-ready");
  if (reduced) { root.classList.add("motion-off"); return; }

  /* ----------------------------------------------------------
     1. Masked type — headings rise from behind their own edge.
        Each <br>-separated line becomes its own mask so multi-line
        headlines cascade rather than moving as one block.
     ---------------------------------------------------------- */
  function maskHeading(el) {
    if (el.dataset.masked) return;
    // Split on <br> so each visual line animates independently.
    var lines = el.innerHTML.split(/<br\s*\/?>/i);
    el.innerHTML = lines
      .map(function (line, i) {
        return '<span class="m-line" style="--i:' + i + '"><span class="m-line-i">' + line + "</span></span>";
      })
      .join("");
    el.dataset.masked = "1";
  }

  document.querySelectorAll(".hero h1, .section-head h2, .reserve-intro h2").forEach(maskHeading);

  /* ----------------------------------------------------------
     2. Reveal on entry, with stagger.
        Children of a [data-stagger] container inherit an index so
        they arrive in sequence instead of all at once.
     ---------------------------------------------------------- */
  document.querySelectorAll("[data-stagger]").forEach(function (group) {
    Array.prototype.forEach.call(group.children, function (child, i) {
      child.classList.add("reveal");
      child.style.setProperty("--i", i);
    });
  });

  var revealTargets = document.querySelectorAll(
    ".reveal, .fade-in, .section-head, .feature-card, .trust-item, .route-card, .faq-item, .reserve-card, .reserve-intro"
  );

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in", "visible");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    revealTargets.forEach(function (el) {
      el.classList.add("reveal");
      io.observe(el);
    });
  } else {
    revealTargets.forEach(function (el) { el.classList.add("in", "visible"); });
  }

  /* The hero is above the fold — it plays on load, not on scroll.

     NOT wrapped in requestAnimationFrame: rAF does not fire in a
     background tab, so a visitor who cmd-clicks the link or restores a
     session would land on an invisible headline. Forcing a reflow
     commits the hidden start state so the transition still animates,
     without depending on a frame ever being painted. */
  var heroEls = document.querySelectorAll(
    ".hero .m-line, .hero-sub, .hero-buttons, .hero-rating, .hero .eyebrow"
  );
  void document.body.offsetHeight; // commit the pre-animation state
  heroEls.forEach(function (el, i) {
    el.style.setProperty("--i", i);
    el.classList.add("in");
  });
  document.body.classList.add("hero-in");

  /* ----------------------------------------------------------
     Dead-man's switch. Motion is decoration; text is the product.
     If anything above fails, or an observer never fires, or the
     browser throttles us into oblivion, everything becomes visible
     anyway. Nothing on this page may stay hidden because an
     animation did not run.
     ---------------------------------------------------------- */
  setTimeout(function () {
    document.querySelectorAll(".reveal, .m-line, .hero-sub, .hero-buttons, .hero-rating, .hero .eyebrow")
      .forEach(function (el) { el.classList.add("in", "visible"); });
  }, 2600);

  /* ----------------------------------------------------------
     3. Hero drift.
        The background moves slower than the page and the content
        settles as it leaves — depth without parallax jitter.
        Driven from a single rAF loop so scroll stays smooth.
     ---------------------------------------------------------- */
  var heroBg = document.querySelector(".hero-bg");
  var heroContent = document.querySelector(".hero-content");
  var hero = document.querySelector(".hero");
  var ticking = false;

  function drift() {
    ticking = false;
    if (!hero) return;
    var y = window.scrollY;
    var h = hero.offsetHeight || 1;
    if (y > h) return;                    // stop working once it's off screen
    var p = Math.min(1, y / h);
    if (heroBg) heroBg.style.transform = "translate3d(0," + (p * 14).toFixed(2) + "%,0) scale(" + (1 + p * 0.06).toFixed(4) + ")";
    if (heroContent) {
      heroContent.style.transform = "translate3d(0," + (p * 40).toFixed(1) + "px,0)";
      heroContent.style.opacity = String(Math.max(0, 1 - p * 1.25));
    }
  }

  window.addEventListener(
    "scroll",
    function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(drift);
    },
    { passive: true }
  );
  drift();

  /* ----------------------------------------------------------
     4. Scroll cue — fades out the moment the visitor starts moving,
        so it reads as an invitation rather than furniture.
     ---------------------------------------------------------- */
  var cue = document.querySelector(".scroll-cue");
  if (cue) {
    window.addEventListener(
      "scroll",
      function () {
        cue.classList.toggle("gone", window.scrollY > 40);
      },
      { passive: true }
    );
  }
})();
