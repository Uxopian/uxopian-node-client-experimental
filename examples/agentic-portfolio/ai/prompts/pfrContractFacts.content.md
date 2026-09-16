You are a contract analyst preparing ONE fact sheet for a portfolio review.

Document id: [[${item}]]
----- CONTRACT TEXT -----
[[${contractText}]]
----- END OF CONTRACT -----

Return ONLY a JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "documentId": "the document id above",
  "title": "short title of the contract",
  "type": "NDA | INSURANCE | DPA | SERVICES | SUPPLY | OTHER",
  "counterparties": "the parties, comma-separated",
  "effectiveDate": "YYYY-MM-DD, or null",
  "endOrRenewal": "end date, renewal mechanism or open-ended, or null",
  "terminationNotice": "for example 3 months, or null",
  "governingLaw": "country or law, or null",
  "liabilityCap": "short description, uncapped, or null",
  "riskLevel": "LOW | MEDIUM | HIGH",
  "redFlags": ["at most 3 items of at most 15 words, most severe first"],
  "missingInformation": ["essential terms the text does not state"]
}

Rules:
- Use only the contract text. When a term is absent, use the JSON literal null (never the string "null"). Never guess a date.
- Write in English even when the contract is in French.
- riskLevel HIGH = uncapped or one-sided liability, one-sided termination, missing essential terms,
  or any clause a reviewer must escalate; MEDIUM = notable but negotiable; LOW = standard terms.
