Below are contract fact sheets (a JSON array, one JSON object per contract):

[(${factSheets})]

Keep ONLY the fact sheets whose riskLevel is exactly "HIGH". For each of them, most severe first, write one
Markdown bullet: **title** (counterparties) — first red flag — one concrete next action for the legal team.
If no fact sheet is HIGH, write exactly: Nothing to escalate.
Return only the bullets. Do not mention the MEDIUM or LOW contracts.
