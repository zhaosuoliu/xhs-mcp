/**
 * @fileoverview HTTP transport server for the MCP protocol.
 * Provides a Hono-based HTTP server as an alternative to stdio transport.
 * Uses StreamableHTTPServerTransport for MCP communication.
 * @module http-server
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createMcpServer } from './server.js';
import { initDatabase } from './db/index.js';
import { getAccountPool } from './core/account-pool.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { config } from './core/config.js';

/**
 * Start the HTTP transport server for the MCP protocol.
 * Uses Hono as the HTTP framework and Bun as the runtime.
 *
 * @param port - Port number to listen on (default: 18060)
 */
export async function startHttpServer(port: number = config.server.port) {
  // Initialize database and account pool
  const db = await initDatabase();
  const pool = getAccountPool(db);

  /**
   * Create a new MCP server and transport for each request.
   * In stateless HTTP mode, each request is independent.
   */
  const getOrCreateServer = async (): Promise<{
    server: Server;
    transport: WebStandardStreamableHTTPServerTransport;
  }> => {
    // For stateless mode, we need a fresh transport per request
    // but can potentially reuse the server logic
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true, // 纯 JSON 响应，请求结束即可安全关闭 transport
    });

    // Create server if not exists, or create new one for each request in stateless mode
    // Note: In stateless HTTP mode, each request is independent
    const server = createMcpServer(pool, db);
    await server.connect(transport);

    return { server, transport };
  };

  const app = new Hono();

  // 未被路由捕获的异常统一记录，否则只返回无日志的 500
  app.onError((err, c) => {
    console.error('Unhandled HTTP error:', err);
    return c.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
      500,
    );
  });

  // Enable CORS for all origins
  app.use(
    '*',
    cors({
      origin: '*',
      exposeHeaders: ['Mcp-Session-Id'],
    }),
  );

  // MCP endpoint using WebStandardStreamableHTTPServerTransport
  app.post('/mcp', async (c) => {
    let server: Server | null = null;
    let transport: WebStandardStreamableHTTPServerTransport | null = null;

    try {
      const result = await getOrCreateServer();
      server = result.server;
      transport = result.transport;

      // Web 标准传输直接消费 fetch Request、返回 fetch Response
      return await transport.handleRequest(c.req.raw);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        },
        500,
      );
    } finally {
      // Clean up transport and server
      if (transport) {
        await transport.close().catch(() => {});
      }
      if (server) {
        await server.close().catch(() => {});
      }
    }
  });

  // Method not allowed for GET/DELETE
  app.get('/mcp', (c) => {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      },
      405,
    );
  });

  app.delete('/mcp', (c) => {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      },
      405,
    );
  });

  // Health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'ok', server: 'xhs-mcp', version: '2.0.0' });
  });

  // Info endpoint
  app.get('/', (c) => {
    return c.json({
      name: 'xhs-mcp',
      version: '2.0.0',
      description: 'Xiaohongshu MCP Server with Multi-Account Support',
      endpoints: {
        mcp: '/mcp',
        health: '/health',
      },
    });
  });

  console.error(`Starting HTTP server on port ${port}...`);
  console.error(`MCP endpoint: http://localhost:${port}/mcp`);

  // Graceful shutdown
  const shutdown = async () => {
    console.error('Shutting down HTTP server...');
    await pool.closeAll();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Bun 运行时用 Bun.serve，Node 运行时用 @hono/node-server
  if (typeof (globalThis as any).Bun !== 'undefined') {
    (globalThis as any).Bun.serve({
      port,
      fetch: app.fetch,
    });
  } else {
    serve({ fetch: app.fetch, port });
  }

  console.error(`HTTP server running on http://localhost:${port}`);
}
