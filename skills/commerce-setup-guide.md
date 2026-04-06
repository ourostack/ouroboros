# Commerce Setup Guide

Human-facing guide for configuring the agent's commerce capabilities.

## Architecture Overview

The agent's commerce system has three pillars:

1. **User Profile**: Secure storage of personal data (name, passport, payment preferences) in Vaultwarden, accessed only when needed for specific transactions.

2. **Booking Delegation**: Direct API access to flight (Duffel) and hotel (LiteAPI) booking systems, plus browser automation fallback for sites without APIs.

3. **Payment**: Stripe Issuing virtual cards created per-transaction, with spend limits and merchant category restrictions. Card numbers never enter the model's context.

## Setup Steps

### 1. Stripe Issuing (Required for Payments)

- Create a Stripe account: https://dashboard.stripe.com
- Enable Stripe Issuing (requires business verification)
- Create a restricted API key: https://dashboard.stripe.com/apikeys
  - Permissions needed: `issuing_cards:write`, `issuing_cards:read`
- Store in vault: `credential_store stripe.com --password <key>`

### 2. Duffel (Flights)

- Create a Duffel account: https://app.duffel.com
- Generate a sandbox token: https://app.duffel.com/tokens
- Store in vault: `credential_store duffel.com --password <token>`

### 3. LiteAPI (Hotels)

- Create a LiteAPI account: https://dashboard.liteapi.travel
- Get your sandbox API key
- Store in vault: `credential_store liteapi.travel --password <key>`
- Configure MCP server in agent.json (see commerce-setup.md skill for details)

### 4. User Profile

Store your travel profile with the agent:
```
user_profile_store '{"legalName":{"first":"...","last":"..."},"email":"...","phone":"...","preferences":{}}'
```

## Tool Reference

### User Profile Tools
| Tool | Description | Trust Level |
|------|-------------|-------------|
| `user_profile_store` | Store/update profile fields | Family |
| `user_profile_get` | Retrieve a specific profile field | Family |
| `user_profile_delete` | Delete entire profile | Family |

### Payment Tools
| Tool | Description | Trust Level |
|------|-------------|-------------|
| `stripe_create_card` | Create a virtual card | Family |
| `stripe_deactivate_card` | Deactivate a card | Family |
| `stripe_list_cards` | List active cards | Family |

### Flight Tools
| Tool | Description | Trust Level |
|------|-------------|-------------|
| `flight_search` | Search for flights | Friend |
| `flight_hold` | Hold a flight offer | Family |
| `flight_book` | Book a flight | Family |
| `flight_cancel` | Cancel a booking | Family |

### Hotel Tools
Hotels are accessed through the LiteAPI MCP server. Tools are dynamically registered when the MCP server connects. Common tools include search, get rates, and book.

## Security Model

### Credential Gateway
All API keys are stored in the agent's Vaultwarden vault. They are never exposed as environment variables or stored in config files. MCP servers receive credentials at startup via `vault:` env resolution.

### Card Number Isolation
Virtual card numbers exist only within the Stripe client's internal functions during a payment flow. They are never:
- Returned to the model in tool outputs
- Included in nerves events or logs
- Stored in any persistent state
- Shown in chat messages

The model only sees card IDs (e.g., `ic_...`) and last-4 digits.

### Trust Gating
- **Family trust required**: All profile, payment, and booking tools
- **Friend trust sufficient**: Flight search (read-only, no payment)
- **Stranger/acquaintance**: No commerce access

### Vault Resolution Failures
When a `vault:` reference cannot be resolved for an MCP server:
- The specific server is skipped (not crashed)
- Other servers continue to start normally
- An error event is emitted with the specific resolution failure
- Error messages are actionable (e.g., "item not found", "field empty")

## Verification Tiers

### Tier 1: Real-Tested
- User profile vault CRUD (tested against live Vaultwarden)
- MCP credential injection (tested with real `vault:` env resolution)
- Tool registration and guardrail enforcement

### Tier 2: Mocked
- Stripe Issuing API calls (mocked SDK)
- Duffel flight API calls (mocked HTTP)
- LiteAPI hotel API calls (MCP config only)
- Full booking flow (profile -> search -> card -> book -> confirm -> deactivate)
- Card number leakage verification

### Post-Handoff
- Real Stripe Issuing card creation (requires live Stripe account with Issuing)
- Real Duffel booking (requires live API key)
- Real LiteAPI hotel search (requires live MCP server)
- Browser automation for Pattern B sites
