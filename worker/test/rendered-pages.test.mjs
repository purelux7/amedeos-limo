/* The admin dashboard and the payment page are shipped as JS template
   literals, which means every backslash in the JavaScript they contain is
   eaten once before the browser sees it. That is not a hypothetical: the
   billing-ZIP check shipped as /^d{5}$/ — five literal letter d's — and
   rejected every real ZIP typed into it, on a page whose only job is to
   take money.

   These tests read the EMITTED html rather than the source file, so an
   escaping mistake fails here instead of in a customer's browser. */

import { check, ok, section, T } from "./harness.mjs";

const W = new URL("..", import.meta.url).pathname;
const { PAY_HTML } = await import(`${W}/paypage.js`);
const { DASHBOARD_HTML } = await import(`${W}/dashboard.js`);

section("Rendered pages — regex escaping survives the template literal");

/* Pull every regex literal out of the emitted page and check that none of
   them contain a character class that has lost its backslash. \d \s \w \D
   are the ones that silently degrade into a literal letter. */
function brokenClasses(html, label) {
  const bad = [];
  // Matches things like {5} or + preceded by a bare d/s/w that should have
  // been \d/\s/\w — the signature of a swallowed backslash inside a regex.
  const regexes = html.match(/\/\^[^\n/]{2,80}\$\//g) || [];
  for (const r of regexes) {
    if (/[^\\\[]\bd\{\d/.test(r) || /^\/\^d\{\d/.test(r)) bad.push(`${label}: ${r}`);
  }
  return bad;
}

const payBad = brokenClasses(PAY_HTML, "paypage");
ok("payment page has no de-escaped \\d in its regexes", payBad.length === 0, payBad.join(" | "));

const dashBad = brokenClasses(DASHBOARD_HTML, "dashboard");
ok("dashboard has no de-escaped \\d in its regexes", dashBad.length === 0, dashBad.join(" | "));

section("Rendered pages — the billing ZIP check actually accepts a ZIP");

/* Lift the shipped pattern straight out of the html and run real input
   through it. This is the exact check the customer's browser runs. */
const m = PAY_HTML.match(/if \(!(\/\^.*?\/)\.test\(zip\)\)/);
ok("payment page still has a ZIP check", Boolean(m));

if (m) {
  const shipped = eval(m[1]);
  ok("accepts 34994", shipped.test("34994"));
  ok("accepts 90210", shipped.test("90210"));
  ok("accepts ZIP+4 34994-1234", shipped.test("34994-1234"));
  ok("rejects empty", !shipped.test(""));
  ok("rejects 1234", !shipped.test("1234"));
  ok("rejects letters", !shipped.test("abcde"));
}

console.log(`\n${T.fail ? "FAILED" : "passed"} — ${T.pass} passed, ${T.fail} failed`);
process.exit(T.fail ? 1 : 0);
