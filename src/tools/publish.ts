/**
 * @fileoverview MCP tool definitions and handlers for publishing content.
 * Provides tools for publishing image/text and video notes.
 * @module tools/publish
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AccountPool } from '../core/account-pool.js';
import { XhsDatabase } from '../db/index.js';
import { executeWithMultipleAccounts, MultiAccountParams } from '../core/multi-account.js';

/**
 * Publishing tool definitions for MCP.
 */
export const publishTools: Tool[] = [
  {
    name: 'xhs_publish_content',
    description:
      'Publish a new image/text note to Xiaohongshu with user-provided images (local paths or HTTP URLs). Requires login.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Note title (max 20 characters)',
        },
        content: {
          type: 'string',
          description: 'Note content/description',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of image file paths (absolute paths) or HTTP URLs',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags/topics for the note',
        },
        scheduleTime: {
          type: 'string',
          description: 'Optional scheduled publish time (ISO 8601 format). If not provided, publishes immediately.',
        },
        location: {
          type: 'string',
          description: 'Optional location keyword to attach (e.g. 国泰百货(天通苑店))',
        },
        locationAddress: {
          type: 'string',
          description: 'Optional location address (from xhs_search_location) to disambiguate same-name POIs',
        },
        account: {
          type: 'string',
          description: 'Account name or ID to use for publishing',
        },
        accounts: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string', enum: ['all'] },
          ],
          description: 'Multiple accounts to publish to (array of names/IDs, or "all")',
        },
      },
      required: ['title', 'content', 'images'],
    },
  },
  {
    name: 'xhs_search_location',
    description:
      'Search location (POI) suggestions for publishing, identical to the official publish page dropdown. Returns name/address/fullAddress/cityName/poiId. Requires login.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Location keyword, e.g. 国泰',
        },
        size: {
          type: 'number',
          description: 'Max results (default 20)',
        },
        account: {
          type: 'string',
          description: 'Account name or ID to use',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'xhs_publish_video',
    description:
      'Publish a new video note to Xiaohongshu. Opens a visible browser window for the publishing process. Requires login.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Note title (max 20 characters)',
        },
        content: {
          type: 'string',
          description: 'Note content/description',
        },
        videoPath: {
          type: 'string',
          description: 'Path to the video file (absolute path)',
        },
        coverPath: {
          type: 'string',
          description: 'Optional path to cover image (absolute path)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags/topics for the note',
        },
        scheduleTime: {
          type: 'string',
          description: 'Optional scheduled publish time (ISO 8601 format). If not provided, publishes immediately.',
        },
        location: {
          type: 'string',
          description: 'Optional location keyword to attach (e.g. 国泰百货(天通苑店))',
        },
        locationAddress: {
          type: 'string',
          description: 'Optional location address (from xhs_search_location) to disambiguate same-name POIs',
        },
        account: {
          type: 'string',
          description: 'Account name or ID to use for publishing',
        },
        accounts: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string', enum: ['all'] },
          ],
          description: 'Multiple accounts to publish to (array of names/IDs, or "all")',
        },
      },
      required: ['title', 'content', 'videoPath'],
    },
  },
];

/**
 * Handle publishing tool calls.
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @param pool - Account pool instance
 * @param db - Database instance
 * @returns MCP tool response
 */
export async function handlePublishTools(name: string, args: any, pool: AccountPool, db: XhsDatabase) {
  switch (name) {
    case 'xhs_publish_content': {
      const params = z
        .object({
          title: z.string().max(20),
          content: z.string(),
          images: z.array(z.string()).min(1),
          tags: z.array(z.string()).optional(),
          scheduleTime: z.string().optional(),
          location: z.string().optional(),
          locationAddress: z.string().optional(),
          account: z.string().optional(),
          accounts: z.union([z.array(z.string()), z.literal('all')]).optional(),
        })
        .parse(args);

      const multiParams: MultiAccountParams = {
        account: params.account,
        accounts: params.accounts,
      };

      const results = await executeWithMultipleAccounts(
        pool,
        db,
        multiParams,
        'publish_content',
        async (ctx) => {
          const result = await ctx.client.publishContent({
            title: params.title,
            content: params.content,
            images: params.images,
            tags: params.tags,
            scheduleTime: params.scheduleTime,
            location: params.location,
            locationAddress: params.locationAddress,
          });

          // Record in database if successful
          if (result.success) {
            db.published.record({
              accountId: ctx.accountId,
              noteId: result.noteId,
              title: params.title,
              content: params.content,
              noteType: 'image',
              images: params.images,
              tags: params.tags,
              status: params.scheduleTime ? 'scheduled' : 'published',
            });
          }

          return result;
        },
        {
          logParams: { title: params.title, imageCount: params.images.length },
          sequential: true, // Publish one at a time to avoid browser conflicts
        },
      );

      if (results.length === 1) {
        return {
          content: [{ type: 'text', text: JSON.stringify(results[0], null, 2) }],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    }

    case 'xhs_publish_video': {
      const params = z
        .object({
          title: z.string().max(20),
          content: z.string(),
          videoPath: z.string(),
          coverPath: z.string().optional(),
          tags: z.array(z.string()).optional(),
          scheduleTime: z.string().optional(),
          location: z.string().optional(),
          locationAddress: z.string().optional(),
          account: z.string().optional(),
          accounts: z.union([z.array(z.string()), z.literal('all')]).optional(),
        })
        .parse(args);

      const multiParams: MultiAccountParams = {
        account: params.account,
        accounts: params.accounts,
      };

      const results = await executeWithMultipleAccounts(
        pool,
        db,
        multiParams,
        'publish_video',
        async (ctx) => {
          const result = await ctx.client.publishVideo({
            title: params.title,
            content: params.content,
            videoPath: params.videoPath,
            coverPath: params.coverPath,
            tags: params.tags,
            scheduleTime: params.scheduleTime,
            location: params.location,
            locationAddress: params.locationAddress,
          });

          // Record in database if successful
          if (result.success) {
            db.published.record({
              accountId: ctx.accountId,
              noteId: result.noteId,
              title: params.title,
              content: params.content,
              noteType: 'video',
              videoPath: params.videoPath,
              tags: params.tags,
              status: params.scheduleTime ? 'scheduled' : 'published',
            });
          }

          return result;
        },
        {
          logParams: { title: params.title, videoPath: params.videoPath },
          sequential: true,
        },
      );

      if (results.length === 1) {
        return {
          content: [{ type: 'text', text: JSON.stringify(results[0], null, 2) }],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    }

    case 'xhs_search_location': {
      const params = z
        .object({
          keyword: z.string().min(1),
          size: z.number().optional(),
          account: z.string().optional(),
        })
        .parse(args);

      const results = await executeWithMultipleAccounts(
        pool,
        db,
        { account: params.account },
        'search_location',
        async (ctx) => {
          return await ctx.client.searchLocation(params.keyword, params.size);
        },
        { logParams: { keyword: params.keyword } },
      );

      const r = results[0];
      if (!r.success) {
        return {
          content: [{ type: 'text', text: `Location search failed: ${r.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: r.result!.length, pois: r.result }, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown publish tool: ${name}`);
  }
}
