# docs.notis.fun — site source

The documentation site, mirrored from the live server. This directory **is** the
source: pages here are byte-identical to what `https://docs.notis.fun` serves.

```
index.html                 Introduction        /
first-principles/          First principles    /first-principles/
architecture/              Architecture        /architecture/
economy/                   Economy             /economy/
karma/                     Karma               /karma/
assets/_nav.html           shared sidebar (SSI include)
```

## The sidebar is one file

Every page's `<aside class="sidebar">` contains:

```html
<!--#include virtual="/assets/_nav.html" -->
```

nginx resolves it server-side (`ssi on;` in the vhost's `location /`). Active
state is set by a small script inside the include, matching `location.pathname`
against each item's `href`.

**Adding a page means editing `assets/_nav.html` — once — not every page.**
Do not inline the nav into a page; it will silently drift from the others.

⚠ Because SSI is resolved by nginx, opening these files over `file://` shows no
sidebar. That is expected. Serve the directory over HTTP to preview properly.

## CSS is deliberately not factored out

Each page carries its own `<style>` block, and they have legitimately diverged —
pages define the components they actually use (tables and ledgers on `karma/`,
cards on `first-principles/`, and so on). Shared extraction was considered and
rejected; revisit only if two pages start needing the same new component.

## Deploying

Webroot is `root:root`, dirs `755`, files `664` — deliberate. The `www-data`
worker can read but not write, so a compromised worker cannot rewrite the site.
That means writing goes through `sudo install`, never a direct `scp` into place.
Passwordless sudo is available for `linuxuser@notis.fun`.

```bash
# one page
scp docs/site/karma/index.html linuxuser@notis.fun:/tmp/karma-index.html
ssh linuxuser@notis.fun '
  sudo install -d -o root -g root -m 755 /var/www/docs.notis.fun/karma
  sudo install -o root -g root -m 664 /tmp/karma-index.html \
       /var/www/docs.notis.fun/karma/index.html'

# the nav (touches every page's sidebar at once — back it up first)
scp docs/site/assets/_nav.html linuxuser@notis.fun:/tmp/_nav.html
ssh linuxuser@notis.fun '
  sudo cp -a /var/www/docs.notis.fun/assets/_nav.html \
             /var/www/docs.notis.fun/assets/_nav.html.bak-$(date +%Y%m%d)
  sudo install -o root -g root -m 664 /tmp/_nav.html \
       /var/www/docs.notis.fun/assets/_nav.html'
```

Verify afterwards — a broken include fails quietly, serving a page with no
sidebar rather than an error:

```bash
curl -s https://docs.notis.fun/karma/ | grep -c 'siteNav'        # expect 1+
curl -s https://docs.notis.fun/karma/ | grep -c 'include virtual' # expect 0
```

To re-sync this directory from the server:

```bash
rsync -a --exclude '*.bak*' linuxuser@notis.fun:/var/www/docs.notis.fun/ docs/site/
```

## Content rules

- **No governance.** Governance mechanics are deliberately unpublished. Nothing
  about voting, chambers, quorums or treasury control belongs on this site.
- **Numbers are placeholders.** Economic constants are untuned. Any page quoting
  figures says so prominently — see the callout on `karma/`.
- **Say what is built.** Mechanics described here are partly still being
  implemented; the footer carries that disclaimer site-wide.
- **"Withdrawn", never "deleted".** Content withdrawal stops propagation and
  records intent; it cannot retract what someone already copied. The wording
  should not imply otherwise.
