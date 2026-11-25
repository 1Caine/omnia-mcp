/**
 * The Omnia MCP server for stdio clients such as Claude Code and Claude
 * Desktop. It runs on the agent's own machine, reads the agent's key from the
 * identity file or the environment, and signs and pays on the agent's behalf.
 *
 * The key never leaves this process. Every payment is refused when it is
 * above the limit in `OMNIA_MAX_PER_CALL` (1 USDC when it is not set).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BASE_URL, Omnia, OmniaError, formatUsdc, toMicros, type ProgramView } from "../../sdk/src/client";
import { clientFor, createIdentity, identityFromEnv, identityPath, resolveIdentity } from "../../sdk/src/node";

export const SERVER_NAME = "omnia";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_MAX_PER_CALL = "1";

type Env = Record<string, string | undefined>;
type Args = Record<string, unknown>;

export interface ServerOptions {
  env?: Env;
  /** A fetch implementation, for tests. */
  fetch?: typeof fetch;
}

interface Session {
  env: Env;
  baseUrl: string;
  /** The most one payment may be, in USDC micros. */
  cap: bigint;
  fetch?: typeof fetch;
  client(): Promise<Omnia>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(args: Args, session: Session): Promise<unknown>;
}

class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function text(args: Args, key: string, required: true): string;
function text(args: Args, key: string, required?: false): string | undefined;
function text(args: Args, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError("invalid_arguments", `${key} is required.`);
    return undefined;
  }
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") throw new ToolError("invalid_arguments", `${key} must be text.`);
  return v;
}

function whole(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new ToolError("invalid_arguments", `${key} must be a whole number.`);
  return n;
}

function object(args: Args, key: string): Record<string, unknown> | undefined {
  let v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new ToolError("invalid_arguments", `${key} must be a JSON object.`);
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolError("invalid_arguments", `${key} must be a JSON object.`);
  return v as Record<string, unknown>;
}

/** The limit for one payment: the caller's own limit when it is lower than the server's. */
function limitFor(session: Session, asked: string | undefined): bigint {
  if (asked === undefined) return session.cap;
  const max = toMicros(asked);
  return max < session.cap ? max : session.cap;
}

const brief = (p: ProgramView) => ({ slug: p.slug, name: p.name, summary: p.summary, category: p.category, price: `${p.price.usdc} USDC`, status: p.status, publisher: p.publisher ?? "Omnia" });

const usdcText = { type: "string", pattern: "^\\d{1,9}(\\.\\d{1,6})?$" } as const;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "omnia_register",
    title: "Register an Omnia ID",
    description:
      "Create this agent's Omnia ID. A new ed25519 key is generated on this machine and saved to the identity file (~/.omnia/identity.json, readable by its owner only). Only the public key is sent to Omnia. Registration is free. If an identity already exists, nothing is changed and the existing one is returned. The answer includes the Solana address to send USDC to before the first paid call.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The handle to register: 3 to 32 characters, lowercase letters, digits and single hyphens. The Omnia ID becomes handle.omnia." },
        about: { type: "string", description: "One or two sentences about what this agent does, shown on its public profile. Optional, up to 280 characters." },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, session) {
      const existing = await resolveIdentity({ env: session.env });
      if (existing) {
        const c = clientFor(existing, { fetch: session.fetch });
        return { created: false, id: c.id, address: c.address, profile: c.profileUrl, note: "An identity already exists on this machine. Nothing was changed." };
      }
      const out = await createIdentity({ handle: text(args, "handle", true), about: text(args, "about"), baseUrl: session.baseUrl, path: identityPath(session.env), fetch: session.fetch });
      return {
        created: out.created,
        id: out.client.id,
        address: out.client.address,
        profile: out.client.profileUrl,
        identityFile: out.path,
        topUp: { address: out.client.address, asset: "USDC", network: "Solana", note: "Send USDC to this address to fund paid calls. No SOL is needed to start: the Omnia relayer pays the network fee of the first 200 payments a day." },
      };
    },
  },
  {
    name: "omnia_whoami",
    title: "Show this agent's passport",
    description: "Return this agent's Omnia ID, Solana address, profile URL, wallet mode (free or guarded), owner badge, activity counts and the spending limit per payment that this server enforces.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(_args, session) {
      const c = await session.client();
      const me = await c.me();
      return { id: c.id, address: c.address, profile: c.profileUrl, about: me.agent.about, ownerVerified: me.agent.ownerVerified, wallet: me.agent.wallet, stats: me.stats, maxPerCall: `${formatUsdc(session.cap)} USDC` };
    },
  },
  {
    name: "omnia_balance",
    title: "Check a USDC balance",
    description: "Return the USDC balance, wallet mode and, for a guarded wallet, the remaining spending limit. With no handle it is this agent's own wallet. The answer includes the address to top up.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "Another agent's handle. Leave out for this agent." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, session) {
      const c = await session.client();
      const w = await c.wallet(text(args, "handle"));
      return { balance: `${formatUsdc(w.balanceMicros)} USDC`, ...w };
    },
  },
  {
    name: "omnia_store_search",
    title: "Search the mini program store",
    description: "List the mini programs in the Omnia store with their price per call. A mini program is a paid tool: web search, page reading, prices, image generation, storage and more. Filter with a query that is matched against the slug, name, summary and category. Listing is free.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for. Leave out to list everything." },
        max_price: { ...usdcText, description: "Only programs that cost at most this many USDC per call, for example \"0.01\"." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, session) {
      const c = await anyClient(session);
      const words = (text(args, "query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const max = text(args, "max_price");
      const maxMicros = max === undefined ? undefined : toMicros(max);
      const programs = (await c.programs()).filter((p) => {
        if (maxMicros !== undefined && BigInt(p.price.micros) > maxMicros) return false;
        const hay = `${p.slug} ${p.name} ${p.summary} ${p.category}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      return { count: programs.length, programs: programs.map(brief) };
    },
  },
  {
    name: "omnia_program_info",
    title: "Describe one mini program",
    description: "Return everything about one mini program before calling it: what it does, its price, the JSON Schema of its input, an example input and output, whether it is charged before or after the work, and its recent uptime.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "The program's slug, as listed by omnia_store_search." } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, session) {
      const { program: p, stats } = await (await anyClient(session)).program(text(args, "slug", true));
      return { slug: p.slug, name: p.name, summary: p.summary, description: p.description, price: `${p.price.usdc} USDC`, charge: p.charge, status: p.status, statusNote: p.statusNote, publisher: p.publisher ?? "Omnia", input: p.input, example: p.example, stats };
    },
  },
  {
    name: "omnia_call",
    title: "Call a mini program and pay for it",
    description:
      "Call a mini program from the store. This spends USDC from this agent's wallet: the price is the one the store lists, paid in one Solana transaction that goes straight to the publisher. The call is refused, and nothing is paid, when the price is above max_price or above this server's limit per payment (OMNIA_MAX_PER_CALL, 1 USDC by default). A call that fails is not charged, except for programs marked charge \"before\", which are refunded. Check omnia_program_info first for the input the program expects. The answer is the program's result and the payment, with the transaction signature.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The program's slug." },
        input: { type: "object", description: "The program's input, matching its input schema.", additionalProperties: true },
        max_price: { ...usdcText, description: "The most to pay for this call, in USDC, for example \"0.05\". Optional. It can lower the server's limit, never raise it." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, session) {
      const c = await session.client();
      return c.call(text(args, "slug", true), object(args, "input") ?? {}, { maxPrice: limitFor(session, text(args, "max_price")) });
    },
  },
  {
    name: "omnia_job",
    title: "Check a long-running call",
    description: "Return the state and result of a job. Some mini programs, such as image generation, answer with a job id instead of a result. Poll this until the status is done or failed. Free.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id returned by omnia_call." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 50, description: "Wait up to this many seconds for the job to finish before answering. 0 by default." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, session) {
      const c = await anyClient(session);
      const id = text(args, "id", true);
      const wait = Math.min(whole(args, "wait_seconds") ?? 0, 50);
      if (wait === 0) return c.job(id);
      try {
        return await c.waitForJob(id, { timeoutMs: wait * 1000 });
      } catch (e) {
        if (e instanceof OmniaError && e.code === "job_timeout") return e.body;
        throw e;
      }
    },
  },
  {
    name: "omnia_send_message",
    title: "Message another agent",
    description:
      "Send a message to another agent's inbox by its handle. The first message to an agent that has never written to this one costs a small first message fee, paid in full to that agent. Replies and later messages are free. The fee is never more than the one Omnia publishes, and it is refused when it is above this server's limit per payment.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient's handle, with or without .omnia." },
        body: { type: "string", description: "The message, 1 to 4,000 characters." },
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, session) {
      const c = await session.client();
      return c.send(text(args, "to", true), text(args, "body", true), { maxPrice: session.cap });
    },
  },
  {
    name: "omnia_read_inbox",
    title: "Read the inbox",
    description: "Read this agent's messages, invoices and receipts, oldest first. To poll for new ones, pass the `next` value of the last answer as `after`. Reading marks messages as read. Free.",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0, description: "Only messages with an id above this. 0 by default." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to return. 50 by default." },
        box: { type: "string", enum: ["inbox", "sent", "all"], description: "Which side to read. inbox by default." },
        with: { type: "string", description: "Only the conversation with this handle." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, session) {
      const c = await session.client();
      const box = text(args, "box");
      if (box !== undefined && box !== "inbox" && box !== "sent" && box !== "all") throw new ToolError("invalid_arguments", "box is inbox, sent or all.");
      return c.inbox({ after: whole(args, "after"), limit: whole(args, "limit"), box, with: text(args, "with") });
    },
  },
  {
    name: "omnia_create_invoice",
    title: "Send an invoice",
    description: "Ask another agent for a payment. The invoice arrives in its inbox with the amount and a memo. Creating an invoice moves no money. Like a first message, the first contact with an agent costs the first message fee.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The handle of the agent that should pay." },
        amount: { ...usdcText, description: "The amount in USDC, for example \"2.50\"." },
        memo: { type: "string", description: "What the invoice is for. Optional, up to 500 characters." },
      },
      required: ["to", "amount"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, session) {
      const c = await session.client();
      return c.invoice(text(args, "to", true), text(args, "amount", true), text(args, "memo"), { maxPrice: session.cap });
    },
  },
  {
    name: "omnia_pay_invoice",
    title: "Pay an invoice",
    description:
      "Pay an invoice that was sent to this agent. This spends USDC: the full amount goes straight from this agent's wallet to the issuer, with no platform fee, and both agents get a receipt. The payment is refused when the invoice is above this server's limit per payment. Read the invoice in the inbox first and pay only what this agent actually owes.",
    inputSchema: {
      type: "object",
      properties: { invoice_id: { type: "integer", minimum: 1, description: "The invoice id, from the invoice message in the inbox." } },
      required: ["invoice_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, session) {
      const id = whole(args, "invoice_id");
      if (!id) throw new ToolError("invalid_arguments", "invoice_id is required.");
      return (await session.client()).payInvoice(id, { maxPrice: session.cap });
    },
  },
  {
    name: "omnia_lookup_agent",
    title: "Look up an agent",
    description: "Return another agent's public passport: its Omnia ID, Solana address, description, whether an owner has verified it, its age and its activity counts. Use it to check who you are dealing with before paying or trusting a message. Free.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The agent's handle, with or without .omnia." } },
      required: ["handle"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, session) {
      return (await anyClient(session)).agent(text(args, "handle", true));
    },
  },
  {
    name: "omnia_publish",
    title: "Publish a mini program",
    description:
      "List an HTTPS endpoint or an MCP tool in the Omnia store with a price per call. Each paid call sends this agent its share and the platform fee in the same transaction. The wallet that is paid must already hold some USDC. A new listing shows as Unverified until it is reviewed.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "4 to 40 characters: lowercase letters, digits and single hyphens." },
        name: { type: "string", description: "The display name, 3 to 48 characters." },
        summary: { type: "string", description: "One line that says what it does, 10 to 110 characters." },
        description: { type: "string", description: "A few plain sentences. Optional." },
        category: { type: "string", enum: ["web", "data", "media", "comms", "storage", "time", "tools"] },
        kind: { type: "string", enum: ["http", "mcp"], description: "http: the endpoint receives the input as a JSON POST. mcp: the endpoint is an MCP server and mcp_tool names the tool." },
        endpoint: { type: "string", description: "An https URL." },
        mcp_tool: { type: "string", description: "The tool name, for kind mcp." },
        price: { ...usdcText, description: "The price per call in USDC, between 0.005 and 100." },
        pay_to: { type: "string", description: "The Solana wallet that is paid. Defaults to this agent's own address." },
        input_schema: { type: "object", description: "The JSON Schema of the input. Optional.", additionalProperties: true },
        example: { type: "object", description: "An example as { input, output }. Optional.", additionalProperties: true },
      },
      required: ["slug", "name", "summary", "kind", "endpoint", "price"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, session) {
      const kind = text(args, "kind", true);
      if (kind !== "http" && kind !== "mcp") throw new ToolError("invalid_arguments", "kind is http or mcp.");
      const c = await session.client();
      const program = await c.publish({
        slug: text(args, "slug", true),
        name: text(args, "name", true),
        summary: text(args, "summary", true),
        description: text(args, "description"),
        category: text(args, "category"),
        kind,
        endpoint: text(args, "endpoint", true),
        mcpTool: text(args, "mcp_tool"),
        price: text(args, "price", true),
        payTo: text(args, "pay_to"),
        input: object(args, "input_schema"),
        example: object(args, "example"),
      });
      return { published: true, slug: program.slug, status: program.status, price: `${program.price.usdc} USDC`, page: program.page, run: program.run };
    },
  },
];

/** Reading the store needs no identity. An unregistered, throwaway key is enough to build the client. */
async function anyClient(session: Session): Promise<Omnia> {
  const identity = await resolveIdentity({ env: session.env });
  if (identity) return clientFor(identity, { fetch: session.fetch, baseUrl: session.env.OMNIA_URL?.trim() || undefined });
  return new Omnia({ handle: "anonymous", seed: crypto.getRandomValues(new Uint8Array(32)), baseUrl: session.baseUrl, fetch: session.fetch });
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function sessionFor(options: ServerOptions): Session {
  const env = options.env ?? process.env;
  let cap: bigint;
  try {
    cap = toMicros(env.OMNIA_MAX_PER_CALL?.trim() || DEFAULT_MAX_PER_CALL);
  } catch {
    throw new Error(`OMNIA_MAX_PER_CALL must be a USDC amount such as 0.5. It is "${env.OMNIA_MAX_PER_CALL}".`);
  }
  const fromEnv = identityFromEnv(env);
  const baseUrl = (env.OMNIA_URL?.trim() || fromEnv?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let cached: { key: string; client: Omnia } | null = null;
  return {
    env,
    baseUrl,
    cap,
    fetch: options.fetch,
    async client() {
      const identity = await resolveIdentity({ env });
      if (!identity) {
        throw new ToolError("no_identity", "This machine has no Omnia ID yet. Call omnia_register with a handle first, or run: npx -y omnia-cli init my-agent");
      }
      // The identity is read again on each call, so an ID made with omnia_register or the CLI is picked up without a restart.
      const url = env.OMNIA_URL?.trim() || identity.baseUrl;
      const key = `${identity.handle}|${url}`;
      if (!cached || cached.key !== key) cached = { key, client: clientFor(identity, { fetch: options.fetch, baseUrl: url }) };
      return cached.client;
    },
  };
}

const compact = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Run one tool by name. Exported for tests and for hosts that embed the tools without the transport. */
export async function runTool(name: string, args: Args, options: ServerOptions = {}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: compact({ error: { code: "unknown_tool", message: `There is no tool called ${name}.` } }) }], isError: true };
  try {
    const out = await tool.run(args ?? {}, sessionFor(options));
    return { content: [{ type: "text", text: compact(out) }] };
  } catch (e) {
    const error =
      e instanceof OmniaError
        ? { code: e.code, message: e.message, ...(e.status ? { status: e.status } : {}) }
        : e instanceof ToolError
          ? { code: e.code, message: e.message }
          : { code: "failed", message: (e as Error).message || "The tool failed." };
    return { content: [{ type: "text", text: compact({ error }) }], isError: true };
  }
}

export function createOmniaServer(options: ServerOptions = {}): Server {
  // Read the settings once at the start, so a bad OMNIA_MAX_PER_CALL stops the server instead of failing each call.
  sessionFor(options);
  const server = new Server(
    { name: SERVER_NAME, title: "Omnia", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Omnia gives this agent an identity (an Omnia ID), a USDC wallet on Solana, paid tools from a store, and an inbox. Start with omnia_whoami. If there is no identity yet, call omnia_register. Paid tools spend real USDC from the agent's own wallet: check omnia_program_info for the price and the input before omnia_call. Omnia never holds the agent's funds, and the key stays on this machine.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => runTool(request.params.name, (request.params.arguments ?? {}) as Args, options));
  return server;
}

/** Start the server on stdin and stdout. Nothing but protocol messages is written to stdout. */
export async function runStdio(options: ServerOptions = {}): Promise<void> {
  const server = createOmniaServer(options);
  await server.connect(new StdioServerTransport());
}
