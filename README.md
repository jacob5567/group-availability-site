# When Are We Free

A group picks a code, everyone paints the hours they're free on a Mon–Sun grid, and the site shows
the overlap. No accounts, no email, no tracking.

Stored per person: a display name, an IANA timezone, and 168 bits of availability — about 60 bytes.
Groups delete themselves after 60 days without use.

## Running it

```sh
npm install
npm run dev          # http://127.0.0.1:8787, KV simulated locally
```

## Deploying

Create a KV namespace and put its id in `wrangler.toml`:

```sh
npx wrangler kv namespace create AVAIL
npx wrangler deploy
```

## How it works

- **`src/worker.js`** — four routes, no auth. Static files are served by the Workers assets binding.
- **`public/`** — one page, vanilla JS, no build step and no runtime dependencies.

### Storage

```
g:<CODE>:meta    { v, name, created }
g:<CODE>:p:<ID>  { n, tz, s }
```

One key per person rather than one blob per group. KV has no compare-and-swap, so a
read-modify-write of a shared blob would silently drop somebody's answer when two people save at the
same moment. Separate keys never contend.

`CODE` is six characters from an alphabet with no `0/O/1/I/L/U`, generated server-side. `ID` is
random, generated in the browser and kept in `localStorage` — that is the whole of "logging back
in", and it's what lets someone edit their own row without an account.

`s` packs the 168 weekday-hours (index `day * 24 + hour`, Monday first) into 21 bytes, base64url.

Writes refresh a 60-day TTL on both keys, so an active group keeps renewing and an abandoned one
disappears on its own. There is no cleanup job and no retention policy to maintain.

### Timezones

A recurring weekday-hour has no date attached, so there is no single correct UTC offset for it —
offsets move with DST. Rather than freeze one at save time, each person's grid is stored **in their
own timezone**, and converted only at render time against today's date:

```js
shift     = round((offset(viewerTz) - offset(personTz)) / 60)
viewerIdx = (((personIdx + shift) % 168) + 168) % 168
```

The modulo is what carries Sunday night in one zone into Monday morning in another.

Two deliberate limitations:

- **Half-hour zones** (India, Nepal, parts of Australia) round to the nearest hour, so a slot can
  sit up to 30 minutes off against a whole-hour zone.
- **One offset is computed per zone from today's date**, so a group spanning a DST changeover shifts
  by an hour on the day it happens. With no dates in the model, there is nothing better to anchor to.

### Reading the results

The overlap view shades each hour by how many people are free. Below it, runs are listed best-first.
A run is a contiguous stretch where *the same set of people* is free — not merely the same count —
so "without Sam" is always accurate.

## Testing

`?tz=Asia/Tokyo` overrides the detected timezone. This is what makes the conversion testable from a
single browser: create a group, save some hours, then reopen the same link with the override and
check the hours moved by the right amount.
