# OAuth Setup for Graph API, Azure DevOps API, and GitHub API

This guide covers the manual Azure/Entra setup required for Ouroboros to call Microsoft Graph API, Azure DevOps API, and GitHub API on behalf of users via OAuth SSO in Teams.

## Prerequisites

- An Azure subscription with access to Azure Portal
- An existing Azure Bot resource (the one used by Ouroboros)
- The app registration for the bot (matching `teams.clientId` in the agent's vault-backed Teams config)
- Admin access to the Azure AD (Entra ID) tenant
- A dev tunnel for local testing

Credential location truth: Teams and OAuth secrets belong in the owning agent's vault. Do not put raw Teams/OAuth secrets in bundle files, repo files, chat, or a machine-wide provider pool. See `docs/auth-and-providers.md` for the locked credential contract.

## 1. Configure the App Registration

### 1.1 Expose an API

1. Go to **Azure Portal** > **App registrations** > select your bot's app registration.
2. Go to **Expose an API**.
3. Set the **Application ID URI** to:
   ```
   api://botid-{your-bot-id}
   ```
   where `{your-bot-id}` is the bot's app ID (same as `teams.clientId` in the agent's vault-backed Teams config).
4. Add a scope:
   - **Scope name**: `access_as_user`
   - **Who can consent**: Admins and users
   - **Admin consent display name**: Access Ouroboros as the user
   - **Admin consent description**: Allows Ouroboros to access Microsoft Graph and Azure DevOps on behalf of the user.
   - **State**: Enabled

### 1.2 Pre-authorize Teams Client IDs

Under **Expose an API** > **Authorized client applications**, add the following Teams client IDs and select the `access_as_user` scope for each:

| Client ID | Application |
|---|---|
| `1fec8e78-bce4-4aaf-ab1b-5451cc387264` | Teams desktop / mobile |
| `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` | Teams web |

### 1.3 Add API Permissions

Go to **API permissions** > **Add a permission**.

**Microsoft Graph (delegated permissions):**
- `User.Read`
- `Mail.ReadWrite`
- `Calendars.ReadWrite`
- `Files.ReadWrite.All`
- `Chat.Read`
- `Sites.ReadWrite.All`

**Azure DevOps (delegated permissions):**
1. Select **APIs my organization uses** > search for **Azure DevOps** (or **Visual Studio Team Services**).
2. Add these delegated permissions:
   - `vso.work_write`
   - `vso.code_write`
   - `vso.build`

After adding all permissions, click **Grant admin consent for {tenant}** if you have admin rights (or ask your admin to do this).

### 1.4 Add a Client Secret (if not already present)

Go to **Certificates & secrets** > **Client secrets** > **New client secret**. Copy the value and store it as `teams.clientSecret` in the agent's vault-backed Teams config.

### 1.5 Authentication Redirect URI

Go to **Authentication** > **Add a platform** > **Web**. Add the redirect URI:
```
https://token.botframework.com/.auth/web/redirect
```

## 2. Create OAuth Connection Settings on the Azure Bot Resource

You need **two** OAuth connection settings on the Azure Bot resource -- one for Microsoft Graph and one for Azure DevOps. Each targets a different token audience.

### 2.1 Graph Connection (`graph`)

1. Go to **Azure Portal** > **Azure Bot** resource > **Configuration** > **OAuth Connection Settings** > **Add Setting**.
2. Fill in:
   - **Name**: `graph` (must match `oauth.graphConnectionName` in the agent's vault-backed OAuth config, default: `graph`)
   - **Service Provider**: Azure Active Directory v2
   - **Client ID**: your bot's app ID (`teams.clientId`)
   - **Client Secret**: your bot's client secret (`teams.clientSecret`)
   - **Token Exchange URL**: `api://botid-{your-bot-id}`
   - **Tenant ID**: your tenant ID (`teams.tenantId`)
   - **Scopes**: `User.Read Mail.ReadWrite Calendars.ReadWrite Files.ReadWrite.All Chat.Read Sites.ReadWrite.All`

### 2.2 ADO Connection (`ado`)

1. Same as above, add another OAuth connection setting.
2. Fill in:
   - **Name**: `ado` (must match `oauth.adoConnectionName` in the agent's vault-backed OAuth config, default: `ado`)
   - **Service Provider**: Azure Active Directory v2
   - **Client ID**: your bot's app ID (`teams.clientId`)
   - **Client Secret**: your bot's client secret (`teams.clientSecret`)
   - **Token Exchange URL**: `api://botid-{your-bot-id}`
   - **Tenant ID**: your tenant ID (`TENANT_ID`)
   - **Scopes**: `499b84ac-1321-427f-aa17-267ca6975798/.default` (this is the Azure DevOps resource ID; the `.default` scope requests all configured ADO permissions)

> **Note**: The ADO scopes use the Azure DevOps resource ID (`499b84ac-1321-427f-aa17-267ca6975798`) rather than the `https://app.vso.com` audience. The `.default` scope requests all permissions configured on the app registration for that resource.

### 2.3 GitHub Connection (`github`)

Unlike Graph and ADO, GitHub uses its own OAuth provider (not AAD v2). You need a **GitHub OAuth App** first.

#### 2.3.1 Create a GitHub OAuth App

1. Go to **github.com** > **Settings** > **Developer settings** > **OAuth Apps** > **New OAuth App** (or create under an organization at `github.com/organizations/{org}/settings/applications`).
2. Fill in:
   - **Application name**: `Ouroboros for Copilot` (users see this on the consent screen)
   - **Homepage URL**: your project URL (e.g., `https://ouroboros.bot`)
   - **Authorization callback URL**: `https://token.botframework.com/.auth/web/redirect`
3. Click **Register application**.
4. Copy the **Client ID**.
5. Click **Generate a new client secret** and copy it (shown only once).

#### 2.3.2 Create the Bot Service Connection

Via Azure Portal:
1. Go to **Azure Bot** resource > **Configuration** > **OAuth Connection Settings** > **Add Setting**.
2. Fill in:
   - **Name**: `github` (must match `oauth.githubConnectionName` in the agent's vault-backed OAuth config)
   - **Service Provider**: GitHub
   - **Client ID**: from the GitHub OAuth App
   - **Client Secret**: from the GitHub OAuth App
   - **Scopes**: `repo` (or `repo,read:org` if you need org access)

Or via Azure CLI:
```bash
az bot authsetting create \
  --name {bot-name} \
  --resource-group {resource-group} \
  --setting-name github \
  --provider-scope-string "repo" \
  --client-id "{github-client-id}" \
  --client-secret "{github-client-secret}" \
  --service "github"
```

#### 2.3.3 Update Agent OAuth Config

Add the connection name to the `oauth` section:
```json
{
  "oauth": {
    "githubConnectionName": "github"
  }
}
```

> **Note**: The GitHub connection is independent of the AAD app registration. Users sign in to GitHub separately from Graph/ADO. The first time a user asks the bot to file a bug, they'll be prompted to authorize with their GitHub account.

> **Important**: The Teams SDK's built-in `signin/verifyState` handler only supports a single `defaultConnectionName` (set to the Graph connection). Third-party OAuth providers like GitHub use the `verifyState` flow (not `tokenExchange`), so the default handler fails with a 412 PreconditionFailed. Ouroboros overrides `signin.verify-state` in `senses/teams.ts` to try all configured connection names. If you add a new OAuth connection, add its connection name to the `allConnectionNames` array.

## 3. Teams Manifest

The manifest already includes `webApplicationInfo` (committed separately):

```json
{
  "webApplicationInfo": {
    "id": "{your-bot-app-id}",
    "resource": "api://botid-{your-bot-app-id}"
  }
}
```

This tells Teams to enable SSO token exchange with the app registration. The `id` must match your bot's app ID and the `resource` must match the Application ID URI set in step 1.1.

## 4. Dev Tunnel Setup (Local Testing)

1. Install dev tunnels: `npm install -g @devtunnels/cli` (or use the VS Code extension).
2. Start a tunnel:
   ```bash
   devtunnel host --port-numbers 3978 --allow-anonymous
   ```
3. Copy the tunnel URL (e.g., `https://xcbc4jjj-3978.usw2.devtunnels.ms`).
4. Update the **Azure Bot** resource > **Configuration** > **Messaging endpoint** to:
   ```
   https://{tunnel-url}/api/messages
   ```
5. Add the tunnel domain to `manifest.json` `validDomains` array.
6. Re-upload the app package to Teams if the manifest changed.

## 5. Required Configuration

Store these entries in the owning agent's vault-backed Teams/OAuth config:

For the Teams fields, the easiest path is:

```bash
ouro connect teams --agent <agent>
```

That guided flow stores the Teams credentials in `runtime/config` and enables `senses.teams.enabled` in `agent.json`.

```json
{
  "teams": {
    "clientId": "your-bot-app-id",
    "clientSecret": "your-bot-client-secret",
    "tenantId": "your-tenant-id"
  },
  "oauth": {
    "graphConnectionName": "graph",
    "adoConnectionName": "ado",
    "githubConnectionName": "github"
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `teams.clientId` | Yes | -- | Bot app registration ID |
| `teams.clientSecret` | Yes* | -- | Bot client secret (*or use `managedIdentityClientId`) |
| `teams.tenantId` | Yes | -- | Azure AD tenant ID |
| `oauth.graphConnectionName` | No | `graph` | Name of the Graph OAuth connection on Azure Bot |
| `oauth.adoConnectionName` | No | `ado` | Name of the ADO OAuth connection on Azure Bot |
| `oauth.githubConnectionName` | No | `""` | Name of the GitHub OAuth connection on Azure Bot |

## 6. Verification

After completing the setup:

1. Start the dev tunnel.
2. Run `npm run teams`.
3. In Teams, message the bot: "Who am I?"
   - This triggers `graph_profile`, which may prompt for Graph signin.
   - After signin, the bot should return your profile (name, email, job title).
4. Ask the bot: "Show my work items in {org}"
   - This triggers `ado_work_items`, which may prompt for ADO signin.
   - After signin, the bot should return your recent work items.
5. Ask the bot: "Create an issue on {owner}/{repo} titled 'Test issue'"
   - This triggers `github_create_issue`, which may prompt for GitHub signin.
   - After signin, the bot should create the issue and return its URL.

If signin fails, check:
- OAuth connection names match between Azure Bot config and the agent's vault-backed OAuth config
- Client secret is valid and not expired
- Scopes are correctly configured
- Admin consent has been granted
- Dev tunnel URL matches the messaging endpoint
