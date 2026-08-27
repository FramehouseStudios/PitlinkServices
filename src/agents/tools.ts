// The agent's tools, bound to one authenticated member session. Session
// scoping is structural: any tool touching a requestId first proves the
// request belongs to the session member — the agent can never read or move
// another member's request, whatever the LLM asks for. Tool failures are
// returned to the model as results, never thrown into the loop.
import type { RequestService } from "../requests/service.js";
import type { RequestRecord } from "../requests/types.js";
import type { LlmToolDef } from "./llm.js";

export interface AgentSession {
  memberId: string;
  /** Conversation id, used to derive idempotency keys for tool effects. */
  conversationId: string;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const num = (args: Record<string, unknown>, field: string): number => {
  const v = args[field];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${field} must be a number`);
  return v;
};
const str = (args: Record<string, unknown>, field: string): string => {
  const v = args[field];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required`);
  return v;
};

export class AgentToolbox {
  constructor(
    private readonly requests: RequestService,
    private readonly session: AgentSession,
    private readonly serviceTypes: readonly string[],
    private readonly defaultCity: string
  ) {}

  defs(): LlmToolDef[] {
    return [
      {
        name: "create_request",
        description:
          "Create a roadside assistance request for the member once the problem and location are clear.",
        parameters: {
          type: "object",
          properties: {
            serviceType: { type: "string", enum: [...this.serviceTypes] },
            city: { type: "string", description: `defaults to ${this.defaultCity}` },
            lat: { type: "number" },
            lng: { type: "number" },
          },
          required: ["serviceType", "lat", "lng"],
        },
      },
      {
        name: "get_request_status",
        description: "Fetch the current status of one of the member's requests.",
        parameters: {
          type: "object",
          properties: { requestId: { type: "string" } },
          required: ["requestId"],
        },
      },
      {
        name: "triage_request",
        description:
          "Mark a request as triaged after diagnosing it. Always try a remote fix in conversation before dispatching.",
        parameters: {
          type: "object",
          properties: { requestId: { type: "string" } },
          required: ["requestId"],
        },
      },
      {
        name: "resolve_remotely",
        description:
          "Close a triaged request WITHOUT dispatching a provider, when the member confirms the guided fix worked.",
        parameters: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            resolutionSummary: { type: "string" },
          },
          required: ["requestId", "resolutionSummary"],
        },
      },
      {
        name: "cancel_request",
        description: "Cancel one of the member's requests at the member's explicit ask.",
        parameters: {
          type: "object",
          properties: { requestId: { type: "string" } },
          required: ["requestId"],
        },
      },
    ];
  }

  async execute(name: string, args: Record<string, unknown>, callId: string): Promise<ToolResult> {
    try {
      switch (name) {
        case "create_request": {
          const record = await this.requests.create(
            { type: "member", id: this.session.memberId },
            {
              serviceType: str(args, "serviceType"),
              city: typeof args.city === "string" && args.city.trim() ? (args.city as string) : this.defaultCity,
              lat: num(args, "lat"),
              lng: num(args, "lng"),
            },
            // Deterministic per conversation+call: a retried tool call cannot
            // create a second request.
            `agent:${this.session.conversationId}:${callId}`
          );
          return { ok: true, data: publicView(record) };
        }
        case "get_request_status": {
          const record = await this.own(str(args, "requestId"));
          return { ok: true, data: publicView(record) };
        }
        case "triage_request": {
          const record = await this.own(str(args, "requestId"));
          const updated = await this.requests.transition(
            { type: "system", id: "triage-agent" },
            record.id,
            "triaged",
            `agent:${this.session.conversationId}:${callId}`
          );
          return { ok: true, data: publicView(updated) };
        }
        case "resolve_remotely": {
          const record = await this.own(str(args, "requestId"));
          const summary = str(args, "resolutionSummary");
          const updated = await this.requests.transition(
            { type: "system", id: "triage-agent" },
            record.id,
            "resolved",
            `agent:${this.session.conversationId}:${callId}`
          );
          return { ok: true, data: { ...publicView(updated), resolutionSummary: summary } };
        }
        case "cancel_request": {
          const record = await this.own(str(args, "requestId"));
          const updated = await this.requests.transition(
            { type: "member", id: this.session.memberId },
            record.id,
            "cancelled",
            `agent:${this.session.conversationId}:${callId}`
          );
          return { ok: true, data: publicView(updated) };
        }
        default:
          return { ok: false, error: `unknown tool ${JSON.stringify(name)}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Session scoping: 'not found' for anything outside this member's requests. */
  private async own(requestId: string): Promise<RequestRecord> {
    const record = await this.requests.get(requestId);
    if (!record || record.memberId !== this.session.memberId) {
      throw new Error(`request ${requestId} not found`);
    }
    return record;
  }
}

function publicView(record: RequestRecord) {
  return {
    requestId: record.id,
    serviceType: record.serviceType,
    city: record.city,
    status: record.status,
  };
}
