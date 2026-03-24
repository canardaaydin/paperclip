import { Router } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agentService, issueService, activityService, documentService } from "../services/index.js";
import { issueComments as issueCommentsTable } from "@paperclipai/db";
import { eq, desc } from "drizzle-orm";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logger } from "../middleware/logger.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function resolveInstructionsFilePath(
  adapterConfig: Record<string, unknown>,
): string | null {
  const instructionsFilePath =
    typeof adapterConfig.instructionsFilePath === "string"
      ? adapterConfig.instructionsFilePath.trim()
      : null;
  if (!instructionsFilePath) return null;
  if (path.isAbsolute(instructionsFilePath)) return instructionsFilePath;
  const cwd =
    typeof adapterConfig.cwd === "string" ? adapterConfig.cwd.trim() : null;
  if (cwd && path.isAbsolute(cwd))
    return path.resolve(cwd, instructionsFilePath);
  return null;
}

function formatConversationAsPrompt(
  messages: ChatMessage[],
  agentName: string,
): string {
  const parts: string[] = [];

  // Build context from conversation history (all but last user message)
  if (messages.length > 1) {
    parts.push("Here is the conversation so far:\n");
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      const label = msg.role === "user" ? "User" : agentName;
      parts.push(`${label}: ${msg.content}\n`);
    }
    parts.push("---\n");
  }

  // The latest user message as the actual prompt
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "user") {
    parts.push(lastMessage.content);
  }

  parts.push(
    "\n\nYou are in a CHAT conversation with a human user. You may use tools to look up context, search files, and gather information to answer thoroughly. " +
    "When asked to generate a report, produce the report in markdown format between <report> and </report> tags. " +
    "The report should be well-structured with headings, bullet points, tables, and other markdown formatting. " +
    "Always include a title heading. Continue the conversation normally outside the report tags.",
  );

  return parts.join("\n");
}

// Strip Claude Code nesting-guard env vars so the spawned process doesn't refuse to start
const CLAUDE_CODE_NESTING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
] as const;

async function buildCompanyContext(db: Db, companyId: string, agents: { id: string; name: string }[]): Promise<string> {
  const issueSvc = issueService(db);
  const actSvc = activityService(db);
  const docSvc = documentService(db);

  const [issuesList, recentActivity] = await Promise.all([
    issueSvc.list(companyId),
    actSvc.list({ companyId }),
  ]);

  // Build agent ID -> name map for readable output
  const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

  const parts: string[] = [];
  parts.push("=== PAPERCLIP COMPANY DATA (from the control plane database) ===\n");

  if (issuesList.length > 0) {
    parts.push(`## Issues (${issuesList.length} total)\n`);

    // Fetch comments and documents for all issues in parallel
    const issueIds = issuesList.map((i) => i.id);
    const [allComments, allDocs] = await Promise.all([
      db
        .select()
        .from(issueCommentsTable)
        .where(eq(issueCommentsTable.companyId, companyId))
        .orderBy(desc(issueCommentsTable.createdAt)),
      Promise.all(issueIds.map((id) =>
        docSvc.listIssueDocuments(id)
          .then((docs) => ({ issueId: id, docs }))
          .catch(() => ({ issueId: id, docs: [] as { key: string; title: string | null; body?: string }[] })),
      )),
    ]);

    const commentsByIssue = new Map<string, typeof allComments>();
    for (const c of allComments) {
      const list = commentsByIssue.get(c.issueId) ?? [];
      list.push(c);
      commentsByIssue.set(c.issueId, list);
    }

    const docsByIssue = new Map<string, { key: string; title: string | null; body: string }[]>();
    for (const { issueId, docs } of allDocs) {
      if (docs.length > 0) {
        docsByIssue.set(issueId, docs.map((d) => ({
          key: d.key,
          title: d.title,
          body: (d as { body?: string }).body ?? "",
        })));
      }
    }

    for (const issue of issuesList) {
      const assignee = issue.assigneeAgentId
        ? (agentNameMap.get(issue.assigneeAgentId) ?? "unknown agent")
        : issue.assigneeUserId ?? "unassigned";
      parts.push(
        `### [${issue.identifier ?? "?"}] ${issue.title}`,
      );
      parts.push(`Status: ${issue.status} | Priority: ${issue.priority ?? "none"} | Assignee: ${assignee}`);
      if (issue.description) {
        const descText = issue.description.substring(0, 500);
        parts.push(`Description: ${descText}${issue.description.length > 500 ? "..." : ""}`);
      }

      // Add comments
      const comments = commentsByIssue.get(issue.id);
      if (comments && comments.length > 0) {
        parts.push(`Comments (${comments.length}):`);
        for (const c of comments.slice(0, 10)) {
          const author = c.authorAgentId
            ? (agentNameMap.get(c.authorAgentId) ?? "agent")
            : c.authorUserId ?? "user";
          const body = c.body.substring(0, 500);
          parts.push(`  [${author}]: ${body}${c.body.length > 500 ? "..." : ""}`);
        }
      }

      // Add documents
      const docs = docsByIssue.get(issue.id);
      if (docs && docs.length > 0) {
        for (const d of docs) {
          parts.push(`Document "${d.title ?? d.key}":`);
          const body = d.body.substring(0, 2000);
          parts.push(body + (d.body.length > 2000 ? "\n...(truncated)" : ""));
        }
      }

      parts.push("");
    }
  }

  if (recentActivity.length > 0) {
    const capped = recentActivity.slice(0, 30);
    parts.push(`## Recent Activity (last ${capped.length} entries)\n`);
    for (const entry of capped) {
      const ts = new Date(entry.createdAt).toISOString().split("T")[0];
      const actorName = entry.agentId
        ? (agentNameMap.get(entry.agentId) ?? entry.actorType)
        : entry.actorType;
      parts.push(
        `- [${ts}] ${entry.action} on ${entry.entityType}/${entry.entityId} (by ${actorName})`,
      );
    }
    parts.push("");
  }

  parts.push("=== END COMPANY DATA ===\n");
  return parts.join("\n");
}

export function chatRoutes(db: Db) {
  const router = Router();
  const svc = agentService(db);

  router.post(
    "/companies/:companyId/agents/:agentId/chat",
    async (req, res) => {
      const { companyId, agentId } = req.params;
      assertBoard(req);
      assertCompanyAccess(req, companyId);

      const agent = await svc.getById(agentId);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (agent.companyId !== companyId) {
        res.status(403).json({ error: "Agent does not belong to this company" });
        return;
      }

      const { messages } = req.body as { messages?: ChatMessage[] };
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "messages array is required" });
        return;
      }

      const adapterConfig =
        agent.adapterConfig && typeof agent.adapterConfig === "object"
          ? (agent.adapterConfig as Record<string, unknown>)
          : {};

      const command =
        typeof adapterConfig.command === "string" && adapterConfig.command.trim()
          ? adapterConfig.command.trim()
          : "claude";

      const cwd =
        typeof adapterConfig.cwd === "string" && adapterConfig.cwd.trim()
          ? adapterConfig.cwd.trim()
          : process.cwd();

      const model =
        typeof adapterConfig.model === "string" && adapterConfig.model.trim()
          ? adapterConfig.model.trim()
          : "";

      // Build instructions file path for --append-system-prompt-file
      const instrPath = resolveInstructionsFilePath(adapterConfig);
      let tempDir: string | null = null;
      let tempInstrFile: string | null = null;

      if (instrPath) {
        try {
          const content = await fs.readFile(instrPath, "utf8");
          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chat-"));
          tempInstrFile = path.join(tempDir, "agent-instructions.md");
          const pathDirective = `\nThe above agent instructions were loaded from ${instrPath}. Resolve any relative file references from ${path.dirname(instrPath)}/.`;
          await fs.writeFile(tempInstrFile, content + pathDirective, "utf8");
        } catch {
          // instructions file not readable, skip
        }
      }

      // Resolve agent skills directory: look for a skills/ dir as sibling of the
      // agents/ directory (e.g. /opt/agent-instructions/GTM-multi-agent-v2/skills/)
      let skillsAddDir: string | null = null;
      if (instrPath) {
        // Walk up from the instructions file to find the repo root with a skills/ dir
        let dir = path.dirname(instrPath);
        for (let i = 0; i < 5; i++) {
          const candidate = path.join(dir, "skills");
          const hasSkills = await fs.stat(candidate).then(s => s.isDirectory()).catch(() => false);
          if (hasSkills) {
            // Build a temp .claude/skills/ dir with symlinks so --add-dir works
            if (!tempDir) tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chat-"));
            const dotClaudeSkills = path.join(tempDir, ".claude", "skills");
            await fs.mkdir(dotClaudeSkills, { recursive: true });
            const entries = await fs.readdir(candidate, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                await fs.symlink(
                  path.join(candidate, entry.name),
                  path.join(dotClaudeSkills, entry.name),
                );
              }
            }
            skillsAddDir = tempDir;
            break;
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }

      // Pre-fetch company data from the Paperclip database to inject as context
      const companyAgents = await svc.list(companyId, { includeTerminated: true });
      const companyContext = await buildCompanyContext(db, companyId, companyAgents);
      const prompt = companyContext + "\n" + formatConversationAsPrompt(messages, agent.name);

      // Build claude CLI args — allow full tool use so agent can search/read context
      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (adapterConfig.dangerouslySkipPermissions === true) {
        args.push("--dangerously-skip-permissions");
      }
      if (model) args.push("--model", model);
      if (tempInstrFile) args.push("--append-system-prompt-file", tempInstrFile);
      if (skillsAddDir) args.push("--add-dir", skillsAddDir);

      // Build env: inherit process.env but strip nesting vars
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") env[key] = value;
      }
      for (const key of CLAUDE_CODE_NESTING_VARS) {
        delete env[key];
      }
      // Merge agent's env config
      if (adapterConfig.env && typeof adapterConfig.env === "object") {
        for (const [key, value] of Object.entries(adapterConfig.env as Record<string, unknown>)) {
          if (typeof value === "string") env[key] = value;
        }
      }

      // Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const log = logger.child({ service: "chat", agentId, agentName: agent.name });

      try {
        log.info({ command, args: args.filter(a => a !== "-"), cwd }, "spawning claude CLI for chat");

        const child = spawn(command, args, {
          cwd,
          env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Pipe prompt via stdin
        child.stdin.write(prompt);
        child.stdin.end();

        let stderr = "";
        let stdoutBuffer = ""; // Buffer for incomplete lines

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");

          // Process complete lines only
          const lines = stdoutBuffer.split("\n");
          // Keep the last (potentially incomplete) line in the buffer
          stdoutBuffer = lines.pop() ?? "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              log.debug({ line: line.substring(0, 200) }, "non-JSON line from claude CLI");
              continue;
            }

            const type = typeof event.type === "string" ? event.type : "";
            log.debug({ eventType: type, hasMessage: !!event.message, hasResult: !!event.result }, "claude stream event");

            if (type === "assistant") {
              // Extract text content from the assistant message
              const message =
                event.message && typeof event.message === "object"
                  ? (event.message as Record<string, unknown>)
                  : {};
              const content = Array.isArray(message.content)
                ? message.content
                : [];
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  !Array.isArray(block) &&
                  (block as Record<string, unknown>).type === "text" &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  const text = (block as Record<string, unknown>).text as string;
                  log.debug({ textLength: text.length }, "sending assistant text delta");
                  res.write(
                    `data: ${JSON.stringify({ type: "delta", text })}\n\n`,
                  );
                }
              }
            } else if (type === "content_block_delta") {
              // Streaming delta format (some CLI versions)
              const delta = event.delta as Record<string, unknown> | undefined;
              if (
                delta &&
                typeof delta === "object" &&
                delta.type === "text_delta" &&
                typeof delta.text === "string"
              ) {
                res.write(
                  `data: ${JSON.stringify({ type: "delta", text: delta.text })}\n\n`,
                );
              }
            } else if (type === "result") {
              // Final result
              if (typeof event.result === "string" && event.result.trim()) {
                log.info({ resultLength: (event.result as string).length }, "chat result received");
                res.write(
                  `data: ${JSON.stringify({ type: "result", text: event.result })}\n\n`,
                );
              }
            }
          }
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("close", (code) => {
          // Process any remaining buffered output
          if (stdoutBuffer.trim()) {
            try {
              const event = JSON.parse(stdoutBuffer.trim()) as Record<string, unknown>;
              const type = typeof event.type === "string" ? event.type : "";
              if (type === "result" && typeof event.result === "string" && event.result.trim()) {
                res.write(
                  `data: ${JSON.stringify({ type: "result", text: event.result })}\n\n`,
                );
              } else if (type === "assistant") {
                const message = event.message && typeof event.message === "object"
                  ? (event.message as Record<string, unknown>) : {};
                const content = Array.isArray(message.content) ? message.content : [];
                for (const block of content) {
                  if (block && typeof block === "object" && !Array.isArray(block) &&
                    (block as Record<string, unknown>).type === "text" &&
                    typeof (block as Record<string, unknown>).text === "string") {
                    res.write(
                      `data: ${JSON.stringify({ type: "delta", text: (block as Record<string, unknown>).text as string })}\n\n`,
                    );
                  }
                }
              }
            } catch {
              // skip
            }
          }

          log.info({ exitCode: code, stderrLength: stderr.length }, "claude CLI exited");
          if (code !== 0 && stderr.trim()) {
            log.warn({ stderr: stderr.substring(0, 500) }, "claude CLI stderr");
            res.write(
              `data: ${JSON.stringify({ type: "error", error: stderr.trim().split("\n")[0] })}\n\n`,
            );
          }
          res.write("data: [DONE]\n\n");
          res.end();

          // Cleanup temp dir
          if (tempDir) {
            fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
          }
        });

        child.on("error", (err) => {
          log.error({ err }, "claude CLI spawn error");
          res.write(
            `data: ${JSON.stringify({ type: "error", error: `Failed to start claude CLI: ${err.message}` })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();

          if (tempInstrFile) {
            fs.rm(path.dirname(tempInstrFile), { recursive: true, force: true }).catch(() => {});
          }
        });

        // Handle client disconnect
        req.on("close", () => {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error during chat";
        log.error({ err }, "chat route error");
        res.write(
          `data: ${JSON.stringify({ type: "error", error: message })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    },
  );

  return router;
}
