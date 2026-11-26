# Review: Vault promo (16 s)

Checked with `hyperframes check` (ok) and snapshots at 0.2, 0.9, 1.8, 2.45, 2.7, 3.4, 4.2, 5.0, 6.4, 7.9, 8.6, 10.6, 11.4, 11.6, 12.3, 12.55, 12.9, 15.75 s.

## Beat sheet
| Time | What the viewer sees | Verdict |
|---|---|---|
| 0.0–2.6 | Mark on screen at frame 0 (thumbnail), springs to size, keyhole appears; "Vault" per letter; tagline per word | OK. Mark is the real logo geometry |
| 2.15–2.6 | Words blur out; mark carries onto the phone's lock-screen logo as the phone rises | OK: lands on the logo in the footage |
| 2.15–5.2 | Real lock screen: passphrase typed, Unlock, list appears. Caption "Your passwords stay on your iPhone." | OK. Phone at scale 0.9 fully in frame |
| 5.2–9.2 | Search types "gmail password", both Gmail logins, password scrambles then shows. Camera punches to 1.3 | OK after re-aim: search bar, both results and the revealed password in frame |
| 9.2–12.15 | "Show them" → Spotify with "Same password as Facebook". Camera to 1.15 | OK after re-aim: warning in frame (bottom edge partly under the app's own Add bar, still readable) |
| 12.15–12.65 | Phone shrinks into the centre; mark grows from it | OK after timing fix (mark no longer appears over a large phone) |
| 12.65–16.0 | Lockup, "Ask your vault.", GitHub pill, facts line; holds 2.3 s+ | OK |

## Fixed during review
- Footage drew in a quarter of the screen: Playwright's recorder padded a 390 × 844 capture; re-recorded with Chrome screencast at 1170 × 2532.
- Keyhole drifted to the bubble's top edge while scaling (SVG origin): now fades in place.
- Punch-ins aimed too high (password and warning cut off): re-aimed.
- Lines under reading time and 27 px footer text: lengthened holds, 29 px.

## Known and accepted
- Silent by design (README video autoplays muted). Music can be added later.
- Nested media `data-start` warnings: local scene timing is intended.
