You are the head of legal operations. Below are the fact sheets (JSON), one per contract of a portfolio:

[[${factSheets}]]

Write a portfolio brief in Markdown, in English, for a busy executive. Use exactly these sections:

## At a glance
One sentence, then bullets: number of contracts, count per type, count per risk level.

## Act now
The HIGH-risk contracts, most severe first, one bullet each:
**title** (counterparties) — top red flag — one concrete next action. If there are none, say so.

## Deadlines and renewals
Every stated end date, renewal mechanism or notice period, soonest first.

## Missing information
Contracts whose fact sheet lists missing essential terms, grouped by missing term.

## Portfolio table
| Contract | Type | Counterparties | Law | Risk | Top red flag | Document id |

Rules: use only the fact sheets, never invent terms or dates, keep everything above the table under 450 words.
