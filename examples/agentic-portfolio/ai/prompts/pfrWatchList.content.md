Below are contract fact sheets (a JSON array, one JSON object per contract):

[(${factSheets})]

Return two Markdown sub-sections and nothing else:
### Deadlines and renewals
One bullet per contract with a non-null effectiveDate, endOrRenewal or terminationNotice: **title** — what is stated. Soonest date first.
### Missing information
Group the missingInformation items by term: one bullet per missing term, followed by the titles of the contracts missing it.
Use only what the fact sheets state.
