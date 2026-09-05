# System Architecture — AI Revenue Recovery

## 5-Layer Architecture

```mermaid
graph TB
    subgraph "Layer 1: Signal Ingestion"
        WEBHOOK["Razorpay Webhooks"]
        INGEST["Ingestion Service<br/><i>Go · chi</i>"]
        REDIS1["Redis Streams"]
    end

    subgraph "Layer 2: Detection & Classification"
        RULES["Rules Engine<br/><i>Go · substring matchers</i>"]
        LLM_CLS["LLM Fallback<br/><i>TypeScript · Groq</i>"]
    end

    subgraph "Layer 3: Decision / Policy Layer"
        POLICY["Policy Functions<br/><i>Go · pure, testable</i>"]
        TRACE["Decision Trace<br/><i>verbatim evidence</i>"]
    end

    subgraph "Layer 4: Execution"
        EXEC["Execution Service<br/><i>TypeScript · Express</i>"]
        ADAPTERS["Channel Adapters<br/><i>SMS · Email · WhatsApp · Voice</i>"]
        RAZORPAY["Razorpay Test API"]
        NEGOTIATE["Negotiation /negotiate<br/><i>TypeScript · LLM Orchestrator</i>"]
    end

    subgraph "Layer 5: Audit Trail & Dashboard"
        POSTGRES["PostgreSQL 16"]
        DASHBOARD["Dashboard<br/><i>Next.js · recharts</i>"]
    end

    WEBHOOK -->|HMAC verify| INGEST
    INGEST -->|event_id| REDIS1
    REDIS1 --> RULES
    RULES -->|classified| POSTGRES
    RULES -->|ambiguous| LLM_CLS
    LLM_CLS --> POSTGRES
    POSTGRES --> POLICY
    POLICY -->|authorized / blocked| POSTGRES
    POLICY -->|action| EXEC
    EXEC --> ADAPTERS
    EXEC --> RAZORPAY
    EXEC --> NEGOTIATE
    NEGOTIATE --> EXEC
    POSTGRES --> DASHBOARD

    style INGEST fill:#e8f5e9,color:#000000
    style RULES fill:#e8f5e9,color:#000000
    style POLICY fill:#e8f5e9,color:#000000
    style EXEC fill:#e3f2fd,color:#000000
    style LLM_CLS fill:#e3f2fd,color:#000000
    style NEGOTIATE fill:#e3f2fd,color:#000000
    style DASHBOARD fill:#fff3e0,color:#000000
    style POSTGRES fill:#fce4ec,color:#000000
```

**Color key:** Green = Go services (correctness-critical), Blue = TypeScript (LLM/UI-fast), Orange = Dashboard, Pink = Database

## Data Flow

```
events → classifications → decisions → actions
  ↑          ↑                ↑           ↑
  |          |                |           |
Ingest    Classify         Decide      Execute
(Go)      (Go+TS)         (Go)        (TS)
```

Every layer writes exactly one row per event. The chain is the audit trail — queryable, filterable, and visible in the dashboard's Audit Log with expandable reasoning traces.

## Why Go + TypeScript

**Go** for layers where correctness is non-negotiable: webhook ingestion (HMAC verification), classification (closed-enum enforcement), and the policy layer (guardrails that stop an agent from moving money). Go's explicit error handling and strong type system make the guardrails testable and auditable.

**TypeScript** for layers where iteration speed and LLM integration matter more: execution adapters, message drafting, negotiation conversations, and the dashboard. The LLM Orchestrator's `/draft` and `/negotiate` endpoints use Groq (free tier) with zod-validated structured output and heuristic fallbacks — tight input, tight output, never in the authorization path.
