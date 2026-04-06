# Commerce Setup Wizard

Step-by-step guide for setting up the agent's commerce infrastructure: payment, booking, and accommodation APIs.

last_verified: 2026-04-06

## Prerequisites

- Agent vault must be set up (run `vault_setup` tool if not done)
- Vault must be reachable at the configured server URL

## Step 1: Stripe Issuing (Payments)

1. Create a Stripe account at https://dashboard.stripe.com
2. Enable Stripe Issuing (requires business verification)
3. Create a restricted API key at https://dashboard.stripe.com/apikeys
   - Enable only `issuing_cards:write` and `issuing_cards:read` permissions
4. Store the key in the vault: `credential_store stripe.com --password <restricted_key> --notes "Stripe Issuing restricted key"`

### Verification
Run `stripe_list_cards` to verify the key works. Expected: empty list or existing cards.

## Step 2: Duffel (Flights)

1. Create a Duffel account at https://app.duffel.com
2. Generate a sandbox API token at https://app.duffel.com/tokens
   - Start with sandbox mode for testing
   - Switch to live mode when ready for real bookings
3. Store the key in the vault: `credential_store duffel.com --password <api_token> --notes "Duffel API token (sandbox)"`

### Verification
Run `flight_search` with any route (e.g., SFO to JFK). Expected: list of flight offers.

## Step 3: LiteAPI (Hotels)

1. Create a LiteAPI account at https://dashboard.liteapi.travel
2. Get your sandbox API key from the dashboard
3. Store the key in the vault: `credential_store liteapi.travel --password <api_key> --notes "LiteAPI sandbox key"`
4. Configure the MCP server in agent.json:
   ```json
   {
     "mcpServers": {
       "liteapi": {
         "command": "npx",
         "args": ["tsx", "src/index.ts"],
         "cwd": "/path/to/liteapi-mcp-server",
         "env": {
           "LITEAPI_API_KEY": "vault:liteapi.travel/apiKey"
         }
       }
     }
   }
   ```

### Verification
The LiteAPI MCP server will start automatically when the agent boots. Check agent logs for `mcp.connect_end` event for the liteapi server.

## Step 4: User Profile

Store the human's travel profile:
```
user_profile_store '{"legalName": {"first": "...", "last": "..."}, "email": "...", "phone": "...", "preferences": {}}'
```

Optional but recommended fields: dateOfBirth, passport, driverLicense, addresses, loyaltyPrograms.

## Self-Test

After setup, run the commerce self-test to verify all services:
- Stripe: creates and deactivates a test virtual card
- Duffel: runs a test flight search
- LiteAPI: verifies the API key is stored in the vault

The self-test reports per-service health with actionable error messages:
- "Flights working, hotels not yet -- LiteAPI key missing."
- "Your Duffel key returned 401. Verify it at app.duffel.com/tokens."

## Security Model

- All API keys stored in the agent's Vaultwarden vault (not env vars)
- Card numbers never appear in model context or logs
- Virtual cards are single-use by default, deactivated after each transaction
- User profile access requires family trust level
- Vault credentials are resolved at MCP server startup, not at runtime
