import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { streamChat, type ChatMessage } from "../api/chat";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MessageSquare,
  Send,
  FileText,
  Download,
  Loader2,
  Bot,
  User,
  Trash2,
} from "lucide-react";

function extractReport(content: string): string | null {
  const match = content.match(/<report>([\s\S]*?)<\/report>/);
  return match ? match[1].trim() : null;
}

function stripReportTags(content: string): string {
  return content.replace(/<report>[\s\S]*?<\/report>/g, "").trim();
}

function getLatestReport(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const report = extractReport(msg.content);
      if (report) return report;
    }
  }
  return null;
}

export function AgentChat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeAgents = (agentsQuery.data ?? []).filter(
    (a) => a.status !== "terminated",
  );

  const selectedAgent = activeAgents.find((a) => a.id === selectedAgentId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !selectedAgentId || !selectedCompanyId || isStreaming)
      return;

    const userMessage: ChatMessage = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setStreamError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = "";
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      await streamChat(
        selectedCompanyId,
        selectedAgentId,
        updatedMessages,
        (delta) => {
          assistantText += delta;
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: assistantText,
            };
            return copy;
          });
        },
        (error) => {
          setStreamError(error);
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStreamError(
          err instanceof Error ? err.message : "Failed to send message",
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, selectedAgentId, selectedCompanyId, isStreaming, messages]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function clearChat() {
    setMessages([]);
    setStreamError(null);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }

  function handleDownloadPdf() {
    const el = reportRef.current;
    if (!el) return;

    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Report</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; color: #1a1a1a; line-height: 1.6; }
            h1 { font-size: 24px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
            h2 { font-size: 20px; margin-top: 24px; }
            h3 { font-size: 16px; margin-top: 20px; }
            table { border-collapse: collapse; width: 100%; margin: 16px 0; }
            th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
            th { background: #f3f4f6; font-weight: 600; }
            ul, ol { padding-left: 24px; }
            code { background: #f3f4f6; padding: 2px 4px; border-radius: 3px; font-size: 13px; }
            pre { background: #f3f4f6; padding: 16px; border-radius: 6px; overflow-x: auto; }
            blockquote { border-left: 4px solid #d1d5db; margin: 16px 0; padding-left: 16px; color: #6b7280; }
            @media print { body { padding: 20px; } }
          </style>
        </head>
        <body>${el.innerHTML}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  if (!selectedCompanyId) return null;

  const report = getLatestReport(messages);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-base font-semibold">Agent Chat</h1>
        <div className="ml-4">
          <Select value={selectedAgentId} onValueChange={(v) => { setSelectedAgentId(v); clearChat(); }}>
            <SelectTrigger className="w-56" size="sm">
              <SelectValue placeholder="Select an agent..." />
            </SelectTrigger>
            <SelectContent>
              {activeAgents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <span className="flex items-center gap-2">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                    {agent.name}
                  </span>
                </SelectItem>
              ))}
              {activeAgents.length === 0 && (
                <SelectItem value="__none__" disabled>
                  No agents available
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            onClick={clearChat}
            title="Clear chat"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Main content: two panels */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel: Chat */}
        <div className="flex flex-1 flex-col min-w-0 border-r border-border">
          {/* Messages area */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {!selectedAgentId && (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Bot className="h-12 w-12 mb-3 opacity-40" />
                <p className="text-sm font-medium">Select an agent to start chatting</p>
                <p className="text-xs mt-1">Choose an agent from the dropdown above</p>
              </div>
            )}

            {selectedAgentId && messages.length === 0 && !isStreaming && (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <MessageSquare className="h-12 w-12 mb-3 opacity-40" />
                <p className="text-sm font-medium">
                  Chat with {selectedAgent?.name ?? "agent"}
                </p>
                <p className="text-xs mt-1">
                  Send a message to start the conversation. Ask for a report and it will appear on the right.
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role === "assistant" && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary mt-0.5">
                    <Bot className="h-4 w-4" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <MarkdownBody>
                      {stripReportTags(msg.content) || (msg.content ? "(generating report...)" : "")}
                    </MarkdownBody>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                  {msg.role === "assistant" &&
                    msg.content === "" &&
                    isStreaming &&
                    i === messages.length - 1 && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Thinking...
                      </span>
                    )}
                </div>
                {msg.role === "user" && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground mt-0.5">
                    <User className="h-4 w-4" />
                  </div>
                )}
              </div>
            ))}

            {streamError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {streamError}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          {selectedAgentId && (
            <div className="border-t border-border p-3 shrink-0">
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Type a message... (Shift+Enter for new line)"
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isStreaming}
                />
                <Button
                  size="sm"
                  onClick={sendMessage}
                  disabled={!input.trim() || isStreaming}
                >
                  {isStreaming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Right panel: Report viewer */}
        <div className="flex w-[45%] min-w-[300px] flex-col bg-muted/20">
          {/* Report header */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 shrink-0">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Report Preview</span>
            {report && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={handleDownloadPdf}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Print / PDF
              </Button>
            )}
          </div>

          {/* Report content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {report ? (
              <div className="p-6" ref={reportRef}>
                <div className="mx-auto max-w-3xl rounded-lg border border-border bg-background p-8 shadow-sm">
                  <MarkdownBody>{report}</MarkdownBody>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <FileText className="h-12 w-12 mb-3 opacity-30" />
                <p className="text-sm font-medium">No report yet</p>
                <p className="text-xs mt-1 max-w-[240px] text-center">
                  Ask the agent to generate a report and it will be rendered here
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
