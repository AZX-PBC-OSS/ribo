import type { CapableChatClient, ChatRequest } from "../phases/chat-client.js";

/**
 * A plain {@link CapableChatClient} double for the phase-level tests, which drive
 * `plan`/`run`/`merge` directly through the phase's `with` and never touch the
 * engine. It records every request and dispatches on the request's structured-
 * output name — the same dispatch key the fill-phase suite's fake uses — so a
 * test scripts a response per call shape.
 *
 * Unlike the `FakeLanguageModel` harness this fake throws the entry IT IS GIVEN,
 * with no transport classification in between: a phase test that needs a
 * `ChatError` of a specific kind hands one in and asserts on what `run` does
 * with it.
 */
export function fakeChat(
  respond: (name: string, request: ChatRequest) => string | Error,
  engine = "fake-chat",
): { chat: CapableChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    chat: {
      engine,
      capability: () => {
        throw new Error("fakeChat: capability() is not exercised by the phase tests");
      },
      complete: async (request) => {
        requests.push(request);
        const entry = respond(request.responseFormat.json_schema.name, request);
        if (typeof entry === "string") {
          return { content: entry, finishReason: "stop" };
        }
        throw entry;
      },
    },
    requests,
  };
}
