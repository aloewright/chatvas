# Cloudflare Deployment Setup Guide

This guide covers the complete setup for deploying Chat Nodes Canvas infrastructure on Cloudflare.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Cloudflare Services Setup](#cloudflare-services-setup)
3. [GitHub Secrets Configuration](#github-secrets-configuration)
4. [Deployment](#deployment)
5. [Cloudflare Access Authentication](#cloudflare-access-authentication)

## Prerequisites

- Cloudflare account with Workers, Pages, and other services enabled
- GitHub repository with appropriate permissions
- Node.js 20+ installed locally
- Wrangler CLI installed (`npm install -g wrangler`)

## Cloudflare Services Setup

### 1. Workers KV

Create a KV namespace for session data:

```bash
# Production namespace
wrangler kv:namespace create "KV"

# Preview namespace
wrangler kv:namespace create "KV" --preview
```

Update `wrangler.toml` with the namespace IDs returned.

### 2. D1 Database

Create a D1 database:

```bash
# Create database
wrangler d1 create chatvas-db

# Create preview database
wrangler d1 create chatvas-db-preview
```

Update `wrangler.toml` with the database IDs returned.

Run migrations:

```bash
# Apply migrations to production
wrangler d1 execute chatvas-db --file=./migrations/0001_initial_schema.sql

# Apply migrations to preview
wrangler d1 execute chatvas-db-preview --file=./migrations/0001_initial_schema.sql
```

### 3. R2 Bucket

Create an R2 bucket for media storage:

```bash
# Production bucket
wrangler r2 bucket create chatvas-media

# Preview bucket
wrangler r2 bucket create chatvas-media-preview
```

Update `wrangler.toml` with bucket names.

### 4. Vectorize Index

Create a Vectorize index for semantic search:

```bash
wrangler vectorize create chatvas-embeddings --dimensions=768 --metric=cosine
```

Update `wrangler.toml` with the index name.

### 5. AI Gateway

Create an AI Gateway in the Cloudflare Dashboard:

1. Go to AI > AI Gateway in your Cloudflare dashboard
2. Create a new gateway named "x"
3. Configure rate limiting and caching as needed
4. Update `wrangler.toml` with the gateway name

### 6. Cloudflare Pages

Create a Pages project:

1. Go to Pages in your Cloudflare dashboard
2. Create a new project named "chatvas"
3. Skip the Git integration (we'll use GitHub Actions)
4. Note your project name and account ID

## GitHub Secrets Configuration

Add the following secrets to your GitHub repository:

1. Go to your GitHub repository
2. Navigate to Settings > Secrets and variables > Actions
3. Add the following secrets:

| Secret Name | Description | Where to Find |
|-------------|-------------|---------------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers, Pages, and D1 permissions | Cloudflare Dashboard > My Profile > API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID | Cloudflare Dashboard > Workers & Pages (in URL) |
| `COMPOSIO_API_KEY` | Composio API key for tool integrations | Composio Dashboard |

### Creating the Cloudflare API Token

Create an API token with the following permissions:
- Account > Workers R2 Storage > Edit
- Account > Workers KV Storage > Edit
- Account > Workers Scripts > Edit
- Account > D1 > Edit
- Account > Cloudflare Pages > Edit
- Account > Vectorize > Edit

## Deployment

### Automatic Deployment (Recommended)

Push to the `main` branch to trigger automatic deployment:

```bash
git add .
git commit -m "Deploy to Cloudflare"
git push origin main
```

This will trigger:
- GitHub Actions workflow for Cloudflare Pages (deploys `/docs` website)
- GitHub Actions workflow for Cloudflare Workers (deploys API)

### Manual Deployment

Deploy Workers manually:

```bash
npm run deploy:worker
```

Deploy Pages manually:

```bash
npm run deploy:pages
```

## Cloudflare Access Authentication

Cloudflare Access provides zero-trust authentication for your application.

### Setup Steps

#### 1. Enable Cloudflare Access

1. Go to Zero Trust in your Cloudflare dashboard
2. Navigate to Access > Applications
3. Click "Add an application"
4. Select "Self-hosted"

#### 2. Configure Application

**Application Configuration:**
- **Application name:** Chat Nodes Canvas API
- **Session duration:** 24 hours
- **Application domain:** `api.chatvas.com` (or your custom domain)
- **Path:** `/api/*`

#### 3. Add Authentication Methods

Configure at least one identity provider:

**Option A: One-time PIN**
- Enable email-based authentication
- Users receive a PIN code to log in

**Option B: OAuth Providers**
- GitHub
- Google
- Microsoft
- Others

**Option C: SAML**
- For enterprise SSO

#### 4. Create Access Policy

Create a policy to control who can access your API:

**Example Policy 1: Allow specific email domains**
```
Rule name: Allow company domain
Include:
  - Email domain is: yourcompany.com
```

**Example Policy 2: Allow specific users**
```
Rule name: Allow specific users
Include:
  - Email is: user1@example.com
  - Email is: user2@example.com
```

**Example Policy 3: Public access with rate limiting**
```
Rule name: Public access
Include:
  - Everyone
Require:
  - Valid session
```

#### 5. Configure Service Tokens (Optional)

For machine-to-machine authentication:

1. Go to Service Auth > Service Tokens
2. Create a new service token
3. Save the Client ID and Client Secret
4. Add to your API clients

#### 6. Testing Access

Test your Access configuration:

```bash
# Without authentication (should be blocked)
curl https://api.chatvas.com/health

# With Cloudflare Access (will redirect to login)
curl -L https://api.chatvas.com/health
```

### Access in Your Worker Code

The Worker automatically receives Cloudflare Access JWT headers:

```javascript
// Example: Verify user identity from Cloudflare Access
export default {
  async fetch(request, env) {
    // Cloudflare Access JWT is in the header
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');

    if (!jwt) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Decode JWT to get user info
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    const userEmail = payload.email;

    // Use userEmail for authorization
    // ...
  }
}
```

### Access Headers Reference

Cloudflare Access injects these headers:

- `Cf-Access-Jwt-Assertion`: JWT token with user identity
- `Cf-Access-User-Id`: User ID
- `Cf-Access-Email`: User email
- `Cf-Access-Group`: User groups

### Rate Limiting with Access

Configure rate limiting in the Cloudflare dashboard:

1. Go to your Access application
2. Click "Configure" > "Settings"
3. Enable rate limiting:
   - Requests per minute: 100
   - Requests per hour: 1000
   - Burst size: 10

## Environment Variables

Set these environment variables in your Worker:

```bash
# Set via Wrangler
wrangler secret put COMPOSIO_API_KEY

# Or via dashboard
# Go to Workers & Pages > chatvas-api > Settings > Variables
```

## Monitoring and Logs

### View Worker Logs

```bash
wrangler tail
```

### View D1 Queries

```bash
wrangler d1 execute chatvas-db --command="SELECT * FROM users LIMIT 10"
```

### View R2 Bucket Contents

```bash
wrangler r2 object list chatvas-media
```

## Troubleshooting

### Common Issues

**Issue: "Unauthorized" when accessing API**
- Solution: Check Cloudflare Access configuration and policies

**Issue: "Namespace not found"**
- Solution: Verify KV namespace IDs in `wrangler.toml`

**Issue: "Database not found"**
- Solution: Verify D1 database IDs and run migrations

**Issue: "R2 bucket not found"**
- Solution: Create R2 buckets and verify names in `wrangler.toml`

### Support

For issues or questions:
- GitHub Issues: https://github.com/aloewright/chatvas/issues
- Cloudflare Docs: https://developers.cloudflare.com/
- Wrangler Docs: https://developers.cloudflare.com/workers/wrangler/

## Next Steps

After deployment:

1. Configure custom domain for API
2. Set up monitoring and alerts
3. Enable analytics in Cloudflare dashboard
4. Configure backup strategy for D1 database
5. Set up CI/CD for automatic testing

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
- [Cloudflare Access Docs](https://developers.cloudflare.com/cloudflare-one/applications/)
- [Vectorize Docs](https://developers.cloudflare.com/vectorize/)
- [AI Gateway Docs](https://developers.cloudflare.com/ai-gateway/)
