Below are contract fact sheets (a JSON array, one JSON object per contract):

[(${factSheets})]

Return ONLY a Markdown table with the columns
| Contract | Type | Counterparties | Law | Risk | Top red flag | Document id |
and exactly one row per fact sheet, in the same order. Contract = title, Top red flag = the first
item of redFlags (or "—"), Risk = riskLevel verbatim. Use "—" for null values. No text before or after the table.
