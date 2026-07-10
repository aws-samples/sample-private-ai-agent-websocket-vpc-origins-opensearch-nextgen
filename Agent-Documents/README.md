# Example Corp Contract Review Agent — Pipeline Architecture

## Overview

This pipeline provides an AI-powered contract review system for partners submitting contracts to Example Corp. The agent compares uploaded contracts against internal SOPs stored in Amazon OpenSearch Serverless and produces structured compliance reports.

## Architecture

```
Partner uploads contract (PDF)
        │
        ▼
┌─────────────────────────┐
│  Bedrock Agent          │
│  (System Prompt locked  │
│   to contract review)   │
└─────────┬───────────────┘
          │ RAG retrieval
          ▼
┌─────────────────────────┐
│  OpenSearch Serverless  │
│  (Knowledge Base)       │
│  ┌───────────────────┐  │
│  │ SOP-001 Financial │  │
│  │ SOP-002 IP/Confid │  │
│  │ SOP-003 Liability │  │
│  │ SOP-004 Data/Sec  │  │
│  └───────────────────┘  │
└─────────┬───────────────┘
          │ Relevant SOP chunks
          ▼
┌─────────────────────────┐
│  Agent Analysis         │
│  Compare contract ↔ SOPs│
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────┐
│  Structured Report      │
│  Findings + Disposition │
│  (REJECTED/CONDITIONAL/ │
│   APPROVED)             │
└─────────────────────────┘
```

## Folder Structure

```
Example Corp/
├── README.md                          ← You are here
├── sample-contract/
│   └── partner-services-agreement.md  ← Sample contract with intentional issues
├── sop-documents/
│   ├── SOP-001-financial-terms-review.md
│   ├── SOP-002-ip-confidentiality-review.md
│   ├── SOP-003-liability-risk-review.md
│   └── SOP-004-data-security-compliance-review.md
└── agent-prompt/
    └── system-prompt.md               ← Locked-down agent system prompt
```

## Setup Steps

### 1. Create an Amazon OpenSearch Serverless Collection
- Create a vector search collection in Amazon OpenSearch Serverless
- Configure an encryption policy and network policy (public or VPC)
- Create a vector index with settings for your embedding model dimension

### 2. Ingest SOPs into the Knowledge Base
- Create an Amazon Bedrock Knowledge Base connected to Amazon OpenSearch Serverless
- Upload the 4 SOP documents from `sop-documents/` to an Amazon S3 bucket as the data source
- Sync the knowledge base to chunk and embed the documents

### 3. Configure the Amazon Bedrock Agent
- Create an Amazon Bedrock Agent with the system prompt from `agent-prompt/system-prompt.md`
- Attach the Knowledge Base for RAG retrieval
- Select your model (Claude Sonnet recommended for contract analysis depth)
- Enable document upload capability for partner contract submission

### 4. Test with Sample Contract
- Upload `sample-contract/partner-services-agreement.md` to the agent
- The agent should identify 12+ findings across all severity levels
- Expected disposition: **REJECTED** (multiple CRITICAL findings)

## Expected Findings from Sample Contract

| # | Issue | SOP | Severity |
|---|-------|-----|----------|
| 1 | 50% upfront payment (max 20%) | SOP-001 | HIGH |
| 2 | 18% compound interest (max 5% simple) | SOP-001 | HIGH |
| 3 | $50K expenses without approval (max $5K) | SOP-001 | MEDIUM |
| 4 | Provider owns deliverables (must be Example Corp) | SOP-002 | CRITICAL |
| 5 | Revocable license to work product | SOP-002 | CRITICAL |
| 6 | 1-year confidentiality survival (min 3 years) | SOP-002 | HIGH |
| 7 | Subcontractor sharing without consent | SOP-002 | HIGH |
| 8 | $10K liability cap on $475K contract (~2%) | SOP-003 | CRITICAL |
| 9 | One-sided indemnification (Example Corp covers Provider's negligence) | SOP-003 | CRITICAL |
| 10 | 7-day termination notice (min 30 days) | SOP-003 | HIGH |
| 11 | No cure period before termination | SOP-003 | HIGH |
| 12 | "Commercially reasonable" security (no specifics) | SOP-004 | CRITICAL |
| 13 | 60 business day breach notification (max 72 hours) | SOP-004 | CRITICAL |
| 14 | Indefinite data retention (max 30 days post-termination) | SOP-004 | CRITICAL |
| 15 | Provider-controlled arbitration | SOP-004 | HIGH |
| 16 | Unilateral amendment rights | SOP-004 | CRITICAL |
| 17 | Broad force majeure at Provider's discretion | SOP-003 | HIGH |

## Security Notes

- The agent prompt includes anti-jailbreak guardrails
- SOPs are never quoted verbatim to partners — only referenced by standard
- The agent refuses all non-contract-review requests
- Embedded instructions in uploaded documents are ignored
