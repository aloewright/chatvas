/**
 * Chat Nodes Canvas - Cloudflare Worker API
 *
 * This worker provides backend infrastructure for:
 * - AI Gateway integration
 * - Media storage (R2)
 * - Vector search (Vectorize)
 * - Canvas state management (Durable Objects)
 * - Database operations (D1)
 * - Composio API integration
 * - Cloudflare Access authentication
 */

export { CanvasContainer } from './canvas-container';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Root landing — something human-friendly instead of a bare 404.
      if (url.pathname === '/' || url.pathname === '') {
        return new Response(ROOT_HTML, {
          headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Auth handoff — browser lands here after sign-in, app polls here for the code.
      if (url.pathname === '/auth/callback') {
        return handleAuthCallback(request, env, url, corsHeaders);
      }
      if (url.pathname === '/auth/poll') {
        return handleAuthPoll(request, env, url, corsHeaders);
      }

      // Canvas container endpoints - Durable Objects
      if (url.pathname.startsWith('/api/canvas/')) {
        return handleCanvasRequest(request, env, url, corsHeaders);
      }

      // Media storage endpoints - R2
      if (url.pathname.startsWith('/api/media/')) {
        return handleMediaRequest(request, env, url, corsHeaders);
      }

      // AI Gateway endpoints
      if (url.pathname.startsWith('/api/ai/')) {
        return handleAIRequest(request, env, url, corsHeaders);
      }

      // Composio API integration endpoints
      if (url.pathname.startsWith('/api/tools/')) {
        return handleToolsRequest(request, env, url, corsHeaders);
      }

      // Vector search endpoints
      if (url.pathname.startsWith('/api/search/')) {
        return handleSearchRequest(request, env, url, corsHeaders);
      }

      // User data endpoints - D1
      if (url.pathname.startsWith('/api/user/')) {
        return handleUserRequest(request, env, url, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

/**
 * Hosted OAuth callback for the Chatvas desktop app.
 *
 * Flow: Electron opens the system browser -> user signs in at auth.pdx.software ->
 * cloudos-auth /native/post-signin mints a one-time code and redirects the browser
 * to chatvas-api /auth/callback?nonce=...&code=...&state=... . We stash the code in
 * AUTH_HANDOFF KV keyed by the app-provided nonce (short TTL) and render a success
 * page. The Electron app is polling /auth/poll?nonce=... and pulls the code on its
 * next tick (burned on first read).
 */
async function handleAuthCallback(_request, env, url, _corsHeaders) {
  const nonce = url.searchParams.get('nonce');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const errParam = url.searchParams.get('error');

  const pageHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

  if (errParam) {
    return new Response(callbackHtml('Sign-in failed', `Error: ${errParam}. You can close this tab.`), { status: 400, headers: pageHeaders });
  }
  if (!nonce || !code) {
    return new Response(callbackHtml('Sign-in failed', 'Missing handoff parameters. You can close this tab.'), { status: 400, headers: pageHeaders });
  }

  await env.AUTH_HANDOFF.put(
    `chatvas-handoff:${nonce}`,
    JSON.stringify({ code, state, ts: Date.now() }),
    { expirationTtl: 120 },
  );

  return new Response(callbackHtml('Signed in', 'You can close this tab and return to Chatvas.'), { headers: pageHeaders });
}

async function handleAuthPoll(_request, env, url, corsHeaders) {
  const nonce = url.searchParams.get('nonce');
  if (!nonce) {
    return new Response(JSON.stringify({ error: 'Missing nonce' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const key = `chatvas-handoff:${nonce}`;
  const raw = await env.AUTH_HANDOFF.get(key);
  if (!raw) {
    return new Response(JSON.stringify({ pending: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  await env.AUTH_HANDOFF.delete(key);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { code: raw }; }
  return new Response(JSON.stringify({ code: parsed.code, state: parsed.state ?? '' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function callbackHtml(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;padding:3rem;max-width:480px;margin:0 auto;color:#222;text-align:center;background:#0f0f1a;color:#e4e4e7}h2{margin-top:0}</style>
<h2>${title}</h2><p>${body}</p>
<script>setTimeout(()=>{try{window.close()}catch(e){}},1500)</script>`;
}

const ROOT_HTML = `<!doctype html><meta charset="utf-8"><title>Chatvas API</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;padding:3rem;max-width:560px;margin:0 auto;background:#0f0f1a;color:#e4e4e7}a{color:#93c5fd}code{background:rgba(255,255,255,.06);padding:.15em .35em;border-radius:4px}</style>
<h1>Chatvas API</h1>
<p>Backend for the Chatvas desktop app: media storage, canvas state, semantic search, and the hosted OAuth handoff.</p>
<p>Endpoints: <code>GET /health</code>, <code>GET /auth/callback</code>, <code>GET /auth/poll</code>, <code>/api/canvas/*</code>, <code>/api/media/*</code>, <code>/api/ai/*</code>, <code>/api/search/*</code>, <code>/api/user/*</code>.</p>`;

/**
 * Handle Canvas Container requests using Durable Objects
 * Each canvas gets its own isolated container for real-time collaboration
 */
async function handleCanvasRequest(request, env, url, corsHeaders) {
  const pathParts = url.pathname.split('/');
  const canvasId = pathParts[3];

  if (!canvasId) {
    return new Response(JSON.stringify({ error: 'Canvas ID required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Get or create Durable Object for this canvas
  const id = env.CANVAS_CONTAINER.idFromName(canvasId);
  const stub = env.CANVAS_CONTAINER.get(id);

  // Forward request to Durable Object
  return stub.fetch(request);
}

/**
 * Handle Media Storage requests using R2
 * Supports images, PDFs, and videos
 */
async function handleMediaRequest(request, env, url, corsHeaders) {
  const pathParts = url.pathname.split('/');
  const action = pathParts[3]; // upload, download, delete, list

  switch (action) {
    case 'upload':
      return handleMediaUpload(request, env, corsHeaders);
    case 'download':
      return handleMediaDownload(request, env, url, corsHeaders);
    case 'delete':
      return handleMediaDelete(request, env, url, corsHeaders);
    case 'list':
      return handleMediaList(request, env, corsHeaders);
    default:
      return new Response('Invalid media action', { status: 400, headers: corsHeaders });
  }
}

async function handleMediaUpload(request, env, corsHeaders) {
  const formData = await request.formData();
  const file = formData.get('file');
  const fileName = formData.get('fileName') || file.name;
  const fileType = file.type;

  // Validate file type
  const allowedTypes = ['image/', 'application/pdf', 'video/'];
  if (!allowedTypes.some(type => fileType.startsWith(type))) {
    return new Response(JSON.stringify({ error: 'Invalid file type' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Generate unique key
  const key = `${Date.now()}-${fileName}`;

  // Upload to R2
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: {
      contentType: fileType,
    },
  });

  // Store metadata in D1
  await env.DB.prepare(
    'INSERT INTO media (key, file_name, file_type, size, uploaded_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(key, fileName, fileType, file.size, new Date().toISOString()).run();

  return new Response(JSON.stringify({ key, fileName, fileType, size: file.size }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleMediaDownload(request, env, url, corsHeaders) {
  const key = url.searchParams.get('key');
  if (!key) {
    return new Response('Key required', { status: 400, headers: corsHeaders });
  }

  const object = await env.MEDIA.get(key);
  if (!object) {
    return new Response('File not found', { status: 404, headers: corsHeaders });
  }

  return new Response(object.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': object.httpMetadata.contentType,
      'Cache-Control': 'public, max-age=31536000',
    },
  });
}

async function handleMediaDelete(request, env, url, corsHeaders) {
  const key = url.searchParams.get('key');
  if (!key) {
    return new Response('Key required', { status: 400, headers: corsHeaders });
  }

  await env.MEDIA.delete(key);
  await env.DB.prepare('DELETE FROM media WHERE key = ?').bind(key).run();

  return new Response(JSON.stringify({ deleted: key }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleMediaList(request, env, corsHeaders) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM media ORDER BY uploaded_at DESC LIMIT 100'
  ).all();

  return new Response(JSON.stringify({ media: results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Handle AI Gateway requests
 * Route AI model requests through Cloudflare AI Gateway
 */
async function handleAIRequest(request, env, url, corsHeaders) {
  const body = await request.json();

  // Use AI Gateway binding "x"
  const response = await env.AI.run(body.model || '@cf/meta/llama-3-8b-instruct', {
    messages: body.messages || [],
    stream: body.stream || false,
  });

  return new Response(JSON.stringify(response), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Handle Composio API tool integration requests
 */
async function handleToolsRequest(request, env, url, corsHeaders) {
  const body = await request.json();

  // Forward to Composio API service
  // This assumes a service binding named COMPOSIO_API
  if (env.COMPOSIO_API) {
    return env.COMPOSIO_API.fetch(request);
  }

  // Fallback: Direct API call
  const composioApiKey = env.COMPOSIO_API_KEY;
  if (!composioApiKey) {
    return new Response(JSON.stringify({ error: 'Composio API key not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const response = await fetch('https://api.composio.dev/v1/tools', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${composioApiKey}`,
    },
    body: JSON.stringify(body),
  });

  return new Response(response.body, {
    status: response.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Handle Vector Search requests using Vectorize
 */
async function handleSearchRequest(request, env, url, corsHeaders) {
  const body = await request.json();
  const { query, topK = 10 } = body;

  if (!query) {
    return new Response(JSON.stringify({ error: 'Query required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Generate embedding for query using AI
  const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: query,
  });

  // Search Vectorize index
  const results = await env.VECTORIZE.query(embedding.data[0], { topK });

  return new Response(JSON.stringify({ results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Handle User data requests using D1
 */
async function handleUserRequest(request, env, url, corsHeaders) {
  const pathParts = url.pathname.split('/');
  const action = pathParts[3];

  switch (request.method) {
    case 'GET':
      const userId = url.searchParams.get('id');
      const { results } = await env.DB.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).bind(userId).all();

      return new Response(JSON.stringify({ user: results[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    case 'POST':
      const userData = await request.json();
      await env.DB.prepare(
        'INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)'
      ).bind(userData.id, userData.name, userData.email, new Date().toISOString()).run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    default:
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
}
