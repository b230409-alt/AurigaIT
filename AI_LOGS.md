# AI Logs

This file records the build conversation for the Round 2 café rewards product. It is included as a required submission artifact.

## User brief

A café chain’s rewards programme. Members earn points on every purchase and redeem them for free items. Regulars reach higher tiers — Silver, then Gold — that earn faster. The counter needs to record a purchase, add the right points, let a member redeem, and always show the correct live balance. Staff look a member up by phone number, and the member list is long.

Build the counter something so every member’s points balance is always exactly right.

(Build it for any café and any member. Get earning, the tiers and redemption right first, then the lookups.)

## Build decisions

The assistant selected Express, SQLite, bcryptjs, JWT authentication, and a static HTML/CSS/JavaScript UI. The balance is derived from an immutable point transaction ledger rather than stored as a mutable member field. The app includes registration/login, REST APIs, search, pagination, sorting, a landing page, and the required documentation.

## Verification

The assistant ran a Node/npm environment check and an API smoke test covering authentication, member creation, purchase earning, tier/balance calculation, redemption validation, and valid redemption.
