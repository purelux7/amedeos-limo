#!/usr/bin/env bash
# Daily SEO health sentinel for allfloridaairportscarservice.com.
# Emails donny@ ONLY on failures — silent otherwise. Same alert-on-fail
# pattern as PureLux's seo-health-check.sh, adapted for a static
# GitHub Pages site (no app server, no /opt/.../.env — reads the Resend
# key from a local dotfile instead).
set -u
FAILS=""

check() {
  local url="$1"; local want="${2:-200}"
  local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$url")
  [ "$code" != "$want" ] && FAILS="${FAILS}\n${code} (want ${want}) ${url}"
}

check https://allfloridaairportscarservice.com/
check https://allfloridaairportscarservice.com/book.html
check https://allfloridaairportscarservice.com/privacy.html
check https://allfloridaairportscarservice.com/terms.html
check https://allfloridaairportscarservice.com/sitemap.xml
check https://allfloridaairportscarservice.com/robots.txt
check https://allfloridaairportscarservice.com/llms.txt
check https://api.allfloridaairportscarservice.com/robots.txt
check https://api.allfloridaairportscarservice.com/api/config

# sitemap should only ever grow — a shrink means a bad commit dropped pages
N=$(curl -s --max-time 20 https://allfloridaairportscarservice.com/sitemap.xml | grep -c "<loc>")
[ "${N:-0}" -lt 4 ] && FAILS="${FAILS}\nsitemap looks collapsed: only ${N} URLs (expect 4+, growing as guides ship)"

# the admin dashboard must never lose its noindex header
ROBOTS_HDR=$(curl -s -D - -o /dev/null --max-time 20 https://api.allfloridaairportscarservice.com/admin | grep -i "^x-robots-tag:")
[ -z "$ROBOTS_HDR" ] && FAILS="${FAILS}\n/admin is missing its X-Robots-Tag: noindex header"

if [ -n "$FAILS" ]; then
  KEY=$(grep "^RESEND_API_KEY=" "$HOME/.resend-afacs.env" | cut -d= -f2-)
  BODY=$(printf "SEO health check failures on allfloridaairportscarservice.com:\n${FAILS}\n\nRun: ~/Code/amedeos-limo/seo-health-check.sh")
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "$(python3 -c "import json,sys;print(json.dumps({\"from\":\"Amedeo's Monitor <reservations@send.pureluxbio.com>\",\"to\":[\"donny@pureluxbio.com\"],\"subject\":\"[allfloridaairportscarservice.com] SEO health check FAILED\",\"text\":sys.argv[1]}))" "$BODY")" > /dev/null
fi
