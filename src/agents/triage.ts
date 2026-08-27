// The tool-calling orchestration loop: model → tool calls → results → model,
// until the model produces a final message or the iteration ceiling is hit.
// The ceiling is a hard guard — a looping model must degrade into a safe
// handoff, never an unbounded burn.
import type { LlmAdapter, LlmMessage } from "./llm.js";
import type { AgentToolbox } from "./tools.js";

export const DEFAULT_SYSTEM_PROMPT = `You are Pitlink's roadside assistance agent. Diagnose the member's situation conversationally.
Prefer guiding the member through a remote fix before any dispatch. Once the problem and location are clear, create a request, triage it, and if the member confirms a guided fix worked, resolve it remotely.
Never promise arrival times or coverage. Never handle payment details in conversation.`;

export interface TriageOutcome {
  /** Final assistant reply for the member. */
  reply: string;
  /** Full transcript including tool traffic, for the conversation store. */
  transcript: LlmMessage[];
  /** True when the loop hit its iteration ceiling instead of finishing. */
  exhausted: boolean;
}

const MAX_ITERATIONS = 8;

export class TriageAgent {
  constructor(
    private readonly llm: LlmAdapter,
    private readonly toolbox: AgentToolbox,
    private readonly systemPrompt: string = DEFAULT_SYSTEM_PROMPT
  ) {}

  async handle(history: LlmMessage[], userMessage: string): Promise<TriageOutcome> {
    const transcript: LlmMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const completion = await this.llm.complete(transcript, this.toolbox.defs());

      if (completion.type === "message") {
        transcript.push({ role: "assistant", content: completion.content });
        return { reply: completion.content, transcript, exhausted: false };
      }

      transcript.push({ role: "assistant", content: "", toolCalls: completion.calls });
      for (const call of completion.calls) {
        const result = await this.toolbox.execute(call.name, call.arguments, call.id);
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    const fallback =
      "I'm having trouble completing this automatically. Your request state is saved — a Pitlink operator will follow up.";
    transcript.push({ role: "assistant", content: fallback });
    return { reply: fallback, transcript, exhausted: true };
  }
}
