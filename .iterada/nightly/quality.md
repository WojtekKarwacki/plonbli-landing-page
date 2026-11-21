# Od Swoich product quality pass

Use the landing page as a first-time visitor would. This is a Polish pre-launch information
site: it has no account, form, database, analytics, or paid API.

## Start a private copy

Run `node scripts/start-product-test-copy.mjs` in the background from the repository root.
Wait until it prints `Product test copy ready`, then run the exact `iterada-browser open ...`
line it prints. The copy is built from this checkout and serves only on loopback. It names its
stand-ins too; currently there are none because all page assets are local and the product makes
no third-party API calls.

Before exploring, read the bound product-test result. Treat a failed gate as the first finding,
then continue only where the private copy is usable.

## Journeys

1. Arrive on the homepage as someone hearing about Od Swoich for the first time. Explain what
   you think the product will do, whether it is already available, and what you can do today.
2. Follow the main call to action into the three-step story. Scroll forward and back through all
   three scenes and check that each picture, route, heading, and paragraph stays readable.
3. Use the page navigation to reach the audience sections and FAQ. Open and close several FAQ
   answers, then verify that every visible call to action lands somewhere useful.
4. Repeat the essential path at a narrow phone width. Check the menu, story images, cards, FAQ,
   footer, focus states, horizontal overflow, and tap targets.
5. Try something that should fail: open a made-up path such as `/nie-ma-takiej-strony`. Confirm
   that the Polish not-found page explains the problem, is not indexable, and offers a working
   route home.

Also open `https://odswoich.pl` read-only and compare its headline, primary calls to action, and
footer with the private copy. Do not submit, create, change, or delete anything on the live site.

## What to notice

Report bugs, dead ends, confusing availability language, contradictions, broken links, visual
jumps, inaccessible controls, browser errors, and differences between the private copy and live
production. Distinguish a product problem from personal taste and include the exact journey and
viewport that exposed it.

There should be no expected console errors, failed requests, analytics calls, consent banner,
sign-in flow, or form submission. The absence of those features is intentional. Leave external
social destinations alone after confirming their link target; do not post or join anything.
