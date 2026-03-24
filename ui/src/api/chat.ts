export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function streamChat(
  companyId: string,
  agentId: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  onError: (error: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ messages }),
      signal,
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { error?: string } | null)?.error ?? `Chat request failed: ${res.status}`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;

      try {
        const event = JSON.parse(payload);
        if (event.type === "delta" || event.type === "result") {
          onDelta(event.text);
        } else if (event.type === "error") {
          onError(event.error);
        }
      } catch {
        // skip
      }
    }
  }
}
