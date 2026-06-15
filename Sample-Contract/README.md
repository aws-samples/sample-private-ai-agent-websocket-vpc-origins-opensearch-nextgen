# Sample Contract

This folder contains a sample partner contract you can download and upload to
the deployed Contract Review Agent to exercise the solution end to end.

## What's here

- `partner-services-agreement.pdf` — a sample Partner Services Agreement that
  intentionally contains numerous issues spanning all four SOP areas (financial
  terms, IP & confidentiality, liability & risk, data & security).

## How to use it

1. Download `partner-services-agreement.pdf` from this folder.
2. Open the deployed agent's web console (the CloudFront URL printed by the
   deploy script) and sign in.
3. Attach/upload the PDF in the chat composer and run the live audit.
4. The agent compares the contract against the SOP knowledge base (stored in
   OpenSearch Serverless NextGen) and returns a structured findings report with
   an overall disposition.

The agent is locked to contract review only — it will decline any request that
is not a contract review against the Example Corp SOPs.

> Expected result for this sample: multiple CRITICAL findings → **REJECTED**.
> See `../Agent-Documents/README.md` for the detailed list of expected findings.
