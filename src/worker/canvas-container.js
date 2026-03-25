/**
 * Canvas Container Durable Object
 *
 * Each infinite canvas gets its own isolated Durable Object instance
 * for real-time state management and collaboration.
 */

export class CanvasContainer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.canvasState = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Initialize canvas state if not loaded
      if (!this.canvasState) {
        this.canvasState = await this.state.storage.get('canvasState') || {
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const pathParts = url.pathname.split('/');
      const action = pathParts[pathParts.length - 1];

      switch (action) {
        case 'state':
          return this.handleGetState(corsHeaders);

        case 'update':
          return this.handleUpdateState(request, corsHeaders);

        case 'websocket':
          return this.handleWebSocket(request);

        case 'reset':
          return this.handleReset(corsHeaders);

        default:
          return new Response('Invalid action', { status: 400, headers: corsHeaders });
      }
    } catch (error) {
      console.error('CanvasContainer error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  async handleGetState(corsHeaders) {
    return new Response(JSON.stringify(this.canvasState), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  async handleUpdateState(request, corsHeaders) {
    const update = await request.json();

    // Merge update with current state
    if (update.nodes) {
      this.canvasState.nodes = update.nodes;
    }
    if (update.edges) {
      this.canvasState.edges = update.edges;
    }
    if (update.viewport) {
      this.canvasState.viewport = update.viewport;
    }

    this.canvasState.updatedAt = new Date().toISOString();

    // Persist to Durable Object storage
    await this.state.storage.put('canvasState', this.canvasState);

    // Broadcast to all connected WebSocket sessions
    this.broadcast({
      type: 'state-update',
      state: this.canvasState,
    });

    return new Response(JSON.stringify({ success: true, state: this.canvasState }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  async handleWebSocket(request) {
    // Upgrade to WebSocket
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Add to active sessions
    this.sessions.add(server);

    // Send current state to new client
    server.send(JSON.stringify({
      type: 'initial-state',
      state: this.canvasState,
    }));

    // Handle incoming messages
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case 'cursor-move':
            // Broadcast cursor position to other clients
            this.broadcast(message, server);
            break;

          case 'node-update':
            // Update node and broadcast
            const nodeIndex = this.canvasState.nodes.findIndex(n => n.id === message.nodeId);
            if (nodeIndex !== -1) {
              this.canvasState.nodes[nodeIndex] = {
                ...this.canvasState.nodes[nodeIndex],
                ...message.data,
              };
              await this.state.storage.put('canvasState', this.canvasState);
              this.broadcast(message);
            }
            break;

          case 'ping':
            server.send(JSON.stringify({ type: 'pong' }));
            break;

          default:
            console.log('Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    // Handle client disconnect
    server.addEventListener('close', () => {
      this.sessions.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleReset(corsHeaders) {
    this.canvasState = {
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.state.storage.put('canvasState', this.canvasState);

    this.broadcast({
      type: 'state-reset',
      state: this.canvasState,
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  broadcast(message, exclude = null) {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);

    for (const session of this.sessions) {
      if (session !== exclude && session.readyState === 1) {
        try {
          session.send(messageStr);
        } catch (error) {
          console.error('Broadcast error:', error);
          this.sessions.delete(session);
        }
      }
    }
  }
}
