import fs from "node:fs/promises";
import path from "node:path";

export interface ResolvedSkill {
  name: string;
  description: string;
}

/**
 * Cache for resolved skills directories. Key is the instructions file path,
 * value is the resolved skills directory path (or null if not found).
 * TTL-based: entries expire after 60 seconds.
 */
const skillsDirCache = new Map<string, { dir: string | null; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Walk up from an instructions file path to find a sibling `skills/` directory.
 * Cached for 60 seconds per unique instructions path.
 *
 * Example: `/opt/agent-instructions/GTM-multi-agent-v2/agents/ceo/AGENTS.md`
 *        → `/opt/agent-instructions/GTM-multi-agent-v2/skills`
 */
export async function resolveSkillsDirForInstructionsPath(
  instructionsFilePath: string,
): Promise<string | null> {
  const cached = skillsDirCache.get(instructionsFilePath);
  if (cached && Date.now() < cached.expiresAt) return cached.dir;

  let dir = path.dirname(instructionsFilePath);
  let result: string | null = null;

  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "skills");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        result = candidate;
        break;
      }
    } catch { /* not found, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  skillsDirCache.set(instructionsFilePath, { dir: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/** Parse a description from SKILL.md YAML frontmatter. */
function parseSkillDescription(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const descMatch = fmMatch[1].match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m,
  );
  if (!descMatch) return "";
  return (descMatch[1] ?? descMatch[2] ?? "")
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * List skills available in a given skills directory.
 * Returns sorted array of { name, description }.
 */
export async function listSkillsInDir(skillsDir: string): Promise<ResolvedSkill[]> {
  const skills: ResolvedSkill[] = [];
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    let description = "";
    try {
      const md = await fs.readFile(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
      description = parseSkillDescription(md);
    } catch { /* no SKILL.md */ }
    skills.push({ name: entry.name, description });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Resolve skills available to an agent based on its instructionsFilePath.
 * Returns null if the agent has no instructions file configured.
 */
export async function resolveAgentSkills(
  instructionsFilePath: string | null | undefined,
): Promise<ResolvedSkill[] | null> {
  if (!instructionsFilePath?.trim()) return null;
  const skillsDir = await resolveSkillsDirForInstructionsPath(instructionsFilePath);
  if (!skillsDir) return null;
  return listSkillsInDir(skillsDir);
}
