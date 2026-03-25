# Cloudflare Environment Setup Quick Reference

This is a quick checklist for setting up the Cloudflare environment. For detailed instructions, see [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).

## ✅ Checklist

### 1. Prerequisites
- [ ] Cloudflare account created
- [ ] Wrangler CLI installed: `npm install -g wrangler`
- [ ] Authenticated: `wrangler login`

### 2. Create Resources

```bash
# Workers KV
wrangler kv:namespace create "KV"
wrangler kv:namespace create "KV" --preview

# D1 Database
wrangler d1 create chatvas-db
wrangler d1 create chatvas-db-preview

# R2 Buckets
wrangler r2 bucket create chatvas-media
wrangler r2 bucket create chatvas-media-preview

# Vectorize Index
wrangler vectorize create chatvas-embeddings --dimensions=768 --metric=cosine
```

### 3. Update wrangler.toml

Replace the placeholder IDs in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"              # ← Replace this
preview_id = "YOUR_KV_PREVIEW_NAMESPACE_ID"  # ← Replace this

[[d1_databases]]
binding = "DB"
database_name = "chatvas-db"
database_id = "YOUR_D1_DATABASE_ID"              # ← Replace this
preview_database_id = "YOUR_D1_PREVIEW_DATABASE_ID"  # ← Replace this
```

### 4. Run Migrations

```bash
# Production
wrangler d1 execute chatvas-db --file=./migrations/0001_initial_schema.sql

# Preview
wrangler d1 execute chatvas-db-preview --file=./migrations/0001_initial_schema.sql
```

### 5. Create AI Gateway

1. Go to Cloudflare Dashboard → AI → AI Gateway
2. Create new gateway named **"x"**
3. Configure rate limiting and caching

### 6. GitHub Secrets

Add these secrets to your GitHub repository (Settings → Secrets → Actions):

- `CLOUDFLARE_API_TOKEN` - Create at: Profile → API Tokens
  - Permissions needed:
    - Account > Workers R2 Storage > Edit
    - Account > Workers KV Storage > Edit
    - Account > Workers Scripts > Edit
    - Account > D1 > Edit
    - Account > Cloudflare Pages > Edit
    - Account > Vectorize > Edit

- `CLOUDFLARE_ACCOUNT_ID` - Found in: Dashboard URL or Workers & Pages overview

- `COMPOSIO_API_KEY` (optional) - From Composio dashboard

### 7. Cloudflare Pages

1. Go to Pages in Cloudflare Dashboard
2. Create new project named **"chatvas"**
3. Skip Git integration (using GitHub Actions)

### 8. Cloudflare Access (Authentication)

1. Go to Zero Trust → Access → Applications
2. Add self-hosted application
3. Configure:
   - Name: Chat Nodes Canvas API
   - Domain: `api.chatvas.com` (or your domain)
   - Path: `/api/*`
4. Add identity provider (Email OTP, Google, GitHub, etc.)
5. Create access policy

### 9. Test Deployment

```bash
# Local development
npm run dev:worker

# Deploy to production
npm run deploy:worker
npm run deploy:pages
```

### 10. Verify

Test endpoints:
```bash
# Health check
curl https://chatvas-api.YOUR-SUBDOMAIN.workers.dev/health

# Canvas state (with authentication)
curl -X POST https://chatvas-api.YOUR-SUBDOMAIN.workers.dev/api/canvas/test-canvas/state
```

## 🔧 Common Commands

```bash
# View Worker logs
wrangler tail

# List KV namespaces
wrangler kv:namespace list

# Query D1 database
wrangler d1 execute chatvas-db --command="SELECT * FROM users LIMIT 5"

# List R2 objects
wrangler r2 object list chatvas-media

# Deploy Worker
wrangler deploy

# Deploy Pages
wrangler pages deploy docs --project-name=chatvas
```

## 📝 Environment Variables

Set secrets in Worker:

```bash
# Interactive prompt
wrangler secret put COMPOSIO_API_KEY

# From file
echo "your-api-key" | wrangler secret put COMPOSIO_API_KEY
```

## 🚨 Troubleshooting

**"Account ID required"**
→ Run `wrangler login` and select your account

**"Namespace not found"**
→ Check IDs in `wrangler.toml` match created resources

**"Unauthorized" on API calls**
→ Configure Cloudflare Access policies

**"Database not found"**
→ Ensure database is created and migrations are run

## 📚 Documentation

- Full Setup: [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)
- Implementation Details: [CLOUDFLARE_IMPLEMENTATION.md](CLOUDFLARE_IMPLEMENTATION.md)
- Cloudflare Docs: https://developers.cloudflare.com/
