# Newtonite Ops — Design Documentation

Newtonite Ops is an internal web application for coordinating operational work: incidents, customer
issues, payment investigations, compliance requests and approval-gated tasks. Each project has a
shared, Excalidraw-style canvas where the team can see and shape its workflow, and a reliable
backend that keeps work consistent when many people act on it at once.

These documents were written **before** implementation and are the contract the code follows.
Where the code and these documents disagree, that is a bug in one of them.

## Reading order

| # | Document | Read it to learn |
|---|---|---|
| 1 | [Product spec](01-product-spec.md) | Who uses it, roles, every feature, assumptions, scope, brief coverage |
| 2 | [Architecture](02-architecture.md) | Components, environments, code layout, request lifecycle, scale plan |
| 3 | [Data model](03-data-model.md) | ER diagram, every table, constraints, indexes, seed data |
| 4 | [Workflow & rules](04-workflow-rules.md) | Workflow graph, transition checks, invariants, item lifecycle, dashboard definitions |
| 5 | [Data flows](05-data-flows.md) | Sequence diagrams for every critical behaviour |
| 6 | [Permissions](06-permissions.md) | Authorization model, role × action matrix, 404 vs 403 |
| 7 | [API contracts](07-api-contracts.md) | Every endpoint, request/response shapes, error codes |
| 8 | [Frontend views](08-frontend-views.md) | Routes, screens, wireframes, state management |
| 9 | [Canvas spec](09-canvas-spec.md) | Canvas elements, tools, sync and conflict model |
| 10 | [Failure scenarios](10-failure-scenarios.md) | What happens when things go wrong |
| 11 | [Test plan](11-test-plan.md) | The dangerous behaviours and the tests that cover them |
| 12 | [Deployment](12-deployment.md) | Local setup, Docker, Vercel + Neon (separate backend and frontend projects), environment variables |
| 13 | [Ask assistant](13-assistant.md) | Optional Groq-powered chat that answers questions using the user's own permissions |

The top-level [ENGINEERING_DECISIONS.md](../ENGINEERING_DECISIONS.md) summarises the key trade-offs.

## The one rule that holds the system together

> Every state-changing request performs **one authorization check** and **one rule check**, then
> writes the **change**, its **activity event** and its **outbox job** in **one database
> transaction**. Either all three are saved, or none is.
