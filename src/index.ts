#!/usr/bin/env node
/**
 * omnia-mcp: the Omnia MCP server on stdio.
 *
 *   claude mcp add omnia -- npx -y omnia-mcp
 */
import { runStdio } from "./server";

runStdio().catch((e: unknown) => {
  // stdout belongs to the protocol, so problems go to stderr.
  process.stderr.write(`omnia-mcp could not start: ${(e as Error).message}\n`);
  process.exit(1);
});
