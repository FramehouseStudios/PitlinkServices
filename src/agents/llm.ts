// Owned LLM adapter contract. Domain code speaks THIS interface only —
// vendor SDKs (OpenAI or otherwise) live behind future adapter
// implementations, and routing/model choice is an open founder decision
// (UNKNOWN_RFI), so nothing here names a vendor or a model.

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Set on assistant messages that requested tools. */
  toolCalls?: LlmToolCall[];
  /** Set on tool messages: which call this result answers. */
  toolCallId?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type LlmCompletion =
  | { type: "message"; content: string }
  | { type: "tool_calls"; calls: LlmToolCall[] };

export interface LlmAdapter {
  complete(messages: LlmMessage[], tools: LlmToolDef[]): Promise<LlmCompletion>;
}

/**
 * Deterministic adapter for tests and offline development: replays a queue of
 * completions. A step may be a function of the transcript so far, so scripts
 * can react to runtime values (e.g. a request id from a tool result). Makes
 * the whole orchestration loop testable with no vendor key and no network.
 */
export type ScriptStep = LlmCompletion | ((messages: LlmMessage[]) => LlmCompletion);

export class ScriptedLlmAdapter implements LlmAdapter {
  readonly seen: LlmMessage[][] = [];

  constructor(private readonly script: ScriptStep[]) {}

  async complete(messages: LlmMessage[], _tools: LlmToolDef[]): Promise<LlmCompletion> {
    this.seen.push(messages);
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedLlmAdapter: script exhausted");
    return typeof next === "function" ? next(messages) : next;
  }
}
