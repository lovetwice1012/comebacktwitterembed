# Provider expansion repair: verification notes

Scope: Instagram posts, Reels, TV and profiles; Niconico video links; BOOTH
item links; and the shared Discord message admission and dispatch path. The
tests exercise provider URL variants, output controls, partial media,
upstream errors and rate limits, and dispatch failures. Private or
login-restricted content is not treated as public content.

On 2026-10-30, read-only public acquisition produced a video card for Niconico
`sm9` with both long and `nico.ms` URLs. The older JSON endpoint returned
HTTP 400 and the current watch page returned HTTP 200. The returned playback
data also created an anonymous HLS session and retrieved a playlist. This is
not an actual Discord send or a complete download verification.

Public Instagram photo, Reel and profile examples produced output. For the
Reel, the resulting source returned `video/mp4` and ffprobe identified video
and audio streams. This one example does not establish availability for every
post, region, access setting or Instagram response format.

Public BOOTH item URLs produced item output. Shop-top URLs now use the public
shop page and, when blocked with HTTP 403, a matching owner-qualified card on
the official BOOTH search page. Live checks returned matching names for two
shops. One publicly indexed shop was not present in the search results, so it
correctly produced the configured failure response instead of an invented
name. Direct shop requests returned 403 both locally and on production. Search
coverage and the full range of Niconico content types remain limitations.

The production trace sample used during diagnosis was read-only, contained
300 recent records per provider and is not a complete service history. It
showed 27 Niconico HTTP 400 failures; Instagram and BOOTH also had completed
records. A large number of records were skipped because the provider was
disabled for the relevant server; this is an existing setting, not a reason
to enable providers globally. Actual user-reported URLs, Discord delivery,
channel permissions and production behavior after deployment remain unverified.

The regression suite includes a real MariaDB test on loopback port 33621,
using a fresh fixture and a generated test schema; no production database or
Discord message was used. On Windows, the complete `npm test` run passed
3,206 tests, failed none, and skipped one POSIX-only shared-group permissions
test. After the shop-top change, the separate provider and message-route suite passed 206 tests with no
skips, and the real SQL expansion-retry suite passed eight with no skips.
Typecheck, targeted ESLint and `git diff --check` also passed. The POSIX test,
actual Discord delivery and production behavior are not covered by these
results. Tests and review must be rerun against the exact release commit
before deployment. Existing local work was preserved in its original checkout.
