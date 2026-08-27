import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { ScriptedLlmAdapter, type LlmMessage, type ScriptStep } from "./llm.js";
import { AgentToolbox, type AgentSession } from "./tools.js";
import { TriageAgent } from "./triage.js";

const MEMBER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION: AgentSession = { memberId: MEMBER_ID, conversationId: "conv-1" };

function setup(script: ScriptStep[]) {
  const evidence = new InMemoryEvidenceStore();
  const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const llm = new ScriptedLlmAdapter(script);
  const toolbox = new AgentToolbox(requests, SESSION, DEFAULT_SERVICE_TYPES, "los-angeles");
  const agent = new TriageAgent(llm, toolbox);
  return { evidence, requests, llm, agent };
}

/** Pull a field out of the most recent tool result in the transcript. */
function lastToolData(messages: LlmMessage[]): any {
  const tool = [...messages].reverse().find((m) => m.role === "tool");
  return JSON.parse(tool!.content);
}

describe("triage agent loop", () => {
  it("runs the full remote-resolution journey: create → triage → resolve, all on the spine", async () => {
    const { evidence, agent } = setup([
      {
        type: "tool_calls",
        calls: [
          {
            id: "c1",
            name: "create_request",
            arguments: { serviceType: "jump_start", lat: 34.05, lng: -118.24 },
          },
        ],
      },
      (messages) => ({
        type: "tool_calls",
        calls: [
          { id: "c2", name: "triage_request", arguments: { requestId: lastToolData(messages).data.requestId } },
        ],
      }),
      (messages) => ({
        type: "tool_calls",
        calls: [
          {
            id: "c3",
            name: "resolve_remotely",
            arguments: {
              requestId: lastToolData(messages).data.requestId,
              resolutionSummary: "Guided member through jump start with cables from a bystander.",
            },
          },
        ],
      }),
      { type: "message", content: "Glad it started! You're all set — no truck needed." },
    ]);

    const outcome = await agent.handle([], "My car won't start, I think the battery is dead.");
    expect(outcome.exhausted).toBe(false);
    expect(outcome.reply).toContain("no truck needed");

    const requestId = outcome.transcript
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content))
      .find((r) => r.ok)!.data.requestId as string;
    const timeline = await evidence.timeline(requestId);
    expect(timeline.map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
      "request.resolved",
    ]);
    // Attribution: the member creates; the software agent triages and resolves.
    expect(timeline.map((e) => e.actorType)).toEqual(["member", "system", "system"]);
    expect(timeline[0]?.actorId).toBe(MEMBER_ID);
  });

  it("failure mode: a tool error is returned to the model, which recovers and continues", async () => {
    const { agent } = setup([
      {
        type: "tool_calls",
        calls: [{ id: "c1", name: "create_request", arguments: { serviceType: "helicopter", lat: 34, lng: -118 } }],
      },
      (messages) => {
        const result = lastToolData(messages);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unknown serviceType/);
        return {
          type: "tool_calls",
          calls: [{ id: "c2", name: "create_request", arguments: { serviceType: "tow", lat: 34, lng: -118 } }],
        };
      },
      { type: "message", content: "A tow request is in." },
    ]);
    const outcome = await agent.handle([], "I need a helicopter I guess?");
    expect(outcome.reply).toBe("A tow request is in.");
    expect(outcome.exhausted).toBe(false);
  });

  it("failure mode: unknown tool names come back as errors, not crashes", async () => {
    const { agent } = setup([
      { type: "tool_calls", calls: [{ id: "c1", name: "launch_satellite", arguments: {} }] },
      (messages) => {
        expect(lastToolData(messages).error).toMatch(/unknown tool/);
        return { type: "message", content: "Let me try that differently." };
      },
    ]);
    const outcome = await agent.handle([], "help");
    expect(outcome.exhausted).toBe(false);
  });

  it("adversarial: the session is member-scoped — the agent cannot read or move another member's request", async () => {
    const { requests, evidence } = setup([]);
    // Seed a foreign request directly through the domain service.
    const foreign = await requests.create(
      { type: "member", id: OTHER_MEMBER_ID },
      { serviceType: "tow", city: "los-angeles", lat: 34, lng: -118 },
      "foreign-1"
    );
    const toolbox = new AgentToolbox(requests, SESSION, DEFAULT_SERVICE_TYPES, "los-angeles");
    for (const name of ["get_request_status", "triage_request", "cancel_request"]) {
      const result = await toolbox.execute(name, { requestId: foreign.id }, `x-${name}`);
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/not found/);
    }
    // The foreign request is untouched: still 'created', only its creation event.
    expect((await requests.get(foreign.id))?.status).toBe("created");
    expect((await evidence.timeline(foreign.id)).map((e) => e.eventType)).toEqual(["request.created"]);
  });

  it("idempotency: a retried tool call with the same call id cannot create a second request", async () => {
    const args = { serviceType: "lockout", lat: 34, lng: -118 };
    const { agent } = setup([
      { type: "tool_calls", calls: [{ id: "same-call", name: "create_request", arguments: args }] },
      { type: "tool_calls", calls: [{ id: "same-call", name: "create_request", arguments: args }] },
      { type: "message", content: "done" },
    ]);
    const outcome = await agent.handle([], "locked out");
    const ids = outcome.transcript
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content).data.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("failure mode: a looping model hits the iteration ceiling and degrades to a safe handoff", async () => {
    const loopStep: ScriptStep = {
      type: "tool_calls",
      calls: [{ id: "c", name: "get_request_status", arguments: { requestId: "00000000-0000-4000-8000-000000000000" } }],
    };
    const { agent } = setup(Array.from({ length: 10 }, () => loopStep));
    const outcome = await agent.handle([], "help");
    expect(outcome.exhausted).toBe(true);
    expect(outcome.reply).toMatch(/operator will follow up/);
  });
});
