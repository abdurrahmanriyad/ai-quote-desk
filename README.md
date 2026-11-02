# AI Quote Desk

Turn messy customer quote requests into accurate drafts that a person approves.

Businesses that quote custom work often receive requests as emails, PDFs and spreadsheets. AI Quote Desk reads the request, extracts what the customer needs, matches it to the catalog, asks about anything missing and prepares a draft quote. The model never sets a price: tested code does that, and nothing is sent until a person approves it.

**Status:** early development. Pricing, sample data and the intake pipeline work. The AI extraction, review screen and evaluation results are not built yet.

## What exists today

- A fictional demo company, Northline Fabrication, with a sample catalog and pricing rules
- Deterministic pricing that refuses incomplete requests and asks for a freight quote above its shipping limit
- 30 reproducible synthetic quote requests with correct answers
- File intake with content checks, duplicate detection, background jobs, retries, crash recovery, tenant separation and an append-only audit trail

All company data, customers and prices in this repository are synthetic.

## Run it

Requires Node 22.

```bash
npm install
npm run verify    # type check and unit tests
npm run samples   # regenerate the sample requests
```

To run the intake pipeline, you also need Docker:

```bash
cp .env.example .env
set -a; . ./.env; set +a
npm run db:up
npm run migrate
npm run test:integration
npm run worker                                    # in one terminal
npm run intake -- data/samples/rfq-001/request.txt   # in another; load .env there too
```

## Sample requests

Each folder in `data/samples` contains the request and a `gold.json` answer. The set includes clean emails, messy threads with changed quantities, missing information, spreadsheets and prompt-injection attempts.

## License

[MIT](LICENSE)
