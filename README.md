# Backend Code Examples — Node.js / TypeScript

Portfolio examples extracted from a production admin-panel backend built with
**[Payload CMS](https://payloadcms.com/)** (v3), **TypeScript**, and **Node.js**.

> These files are illustrative excerpts. Internal service imports (`@/services/*`,
> `@/utils/*`, etc.) are referenced but not included — they are proprietary.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Language | TypeScript 5 |
| Framework | Payload CMS v3 (headless CMS / API framework) |
| Auth | Custom JWT strategy (stateless) |
| Database | MongoDB (via Payload) |
| Logging | Structured logger with tenant-scoped context |

---

## File Overview

### `src/endpoints/customers/createSessionEndpoint.ts`
A **factory function** that generates a reusable `POST` endpoint for storing an
AI chat session ID on the authenticated customer's document.

Demonstrates:
- Endpoint factory / higher-order function pattern
- Input validation with early returns
- Structured logging with tenant context (`<tenantId>`)
- Typed responses with `IApiResponse<T>`

### `src/endpoints/companies/getMe.ts`
`GET /api/companies/me` — returns the authenticated customer's full profile.

Demonstrates:
- Field-level `populate` filtering (stripping PII / internal fields)
- Multi-tenant RBAC enrichment
- Graceful degradation (non-fatal `try/catch` for optional data)
- Soft-delete awareness (exposing owner contact on deleted company)

### `src/endpoints/companies/createForDeveloper.ts`
`POST /api/companies/create-for-developer` — full developer onboarding flow.

Demonstrates:
- Multi-step orchestration with per-step error isolation
- Tenant provisioning (storage, API keys, AI employees, campaigns)
- Role-based access guard (`AccountType.DEVELOPER` only)
- JWT issuance scoped to the newly created company

### `src/collections/Customers.ts`
Payload CMS **collection definition** for the `customers` resource.

Demonstrates:
- Custom stateless JWT auth strategy
- Multi-tenant RBAC via `companyMemberships` array
- Lifecycle hooks (`afterDelete`)
- Password-reset email via a template engine
- Relationship fields with dynamic `filterOptions`

---

## Auth Flow (simplified)

```
Client                     API
  │                          │
  │── POST /customers/login ─►│  Standard Payload login
  │◄─ { accessToken } ───────│
  │                          │
  │── GET /companies/me ─────►│  customEndpointAuth middleware
  │   Authorization: Bearer  │    └─ verifies JWT → attaches req.user
  │◄─ { profile, rbac, … } ──│
```

---

## Multi-tenant RBAC

Each customer can belong to multiple companies, each with its own role preset:

```
Customer
  └─ companyMemberships[]
       ├─ { company: "company-a", role: "admin-preset" }
       └─ { company: "company-b", role: "viewer-preset" }
```

Permissions are resolved at request time via `getRbacEnrichmentForMe()`.

---

*No secrets, API keys, or environment-specific values are present in these files.*
*All sensitive configuration is read from environment variables at runtime.*
