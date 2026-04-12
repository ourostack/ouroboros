import * as fs from "fs";
import * as path from "path";
import { getAgentRoot, getRepoRoot } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";

// Skills live in {agentRoot}/skills/ directory
export function getSkillsDir(): string {
  return path.join(getAgentRoot(), "skills");
}

// Protocol mirror files live in {agentRoot}/skills/protocols/.
function getProtocolMirrorDir(): string {
  return path.join(getSkillsDir(), "protocols");
}

// Harness-level skills live in {repoRoot}/skills/ directory.
export function getHarnessSkillsDir(): string {
  return path.join(getRepoRoot(), "skills");
}

function listMarkdownBasenames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.basename(f, ".md"))
    .sort();
}

// process-local store for loaded skills
const loadedSkills: string[] = [];

export function listSkills(): string[] {
  emitNervesEvent({
    event: "repertoire.load_start",
    component: "repertoire",
    message: "listing skills",
    meta: { operation: "listSkills" },
  });
  const baseSkills = listMarkdownBasenames(getSkillsDir());
  const protocolMirrors = listMarkdownBasenames(getProtocolMirrorDir());
  const harnessSkills = listMarkdownBasenames(getHarnessSkillsDir());

  // Agent skills (base + protocol) come first; harness skills are fallback.
  // Set deduplicates by name — agent overrides harness.
  const skills = [...new Set([...baseSkills, ...protocolMirrors, ...harnessSkills])].sort();
  emitNervesEvent({
    event: "repertoire.load_end",
    component: "repertoire",
    message: "listed skills",
    meta: { operation: "listSkills", count: skills.length },
  });
  return skills;
}

export function loadSkill(skillName: string): string {
  emitNervesEvent({
    event: "repertoire.load_start",
    component: "repertoire",
    message: "loading skill",
    meta: { operation: "loadSkill", skill: skillName },
  });
  const directSkillPath = path.join(getSkillsDir(), `${skillName}.md`);
  const protocolMirrorPath = path.join(getProtocolMirrorDir(), `${skillName}.md`);
  const harnessSkillPath = path.join(getHarnessSkillsDir(), `${skillName}.md`);

  let resolvedPath: string | null = null;

  // 1) Direct agent skill.
  if (fs.existsSync(directSkillPath)) {
    resolvedPath = directSkillPath;
  }
  // 2) Protocol mirror in bundle.
  else if (fs.existsSync(protocolMirrorPath)) {
    resolvedPath = protocolMirrorPath;
  }
  // 3) Harness-level skill (ships with npm package).
  else if (fs.existsSync(harnessSkillPath)) {
    resolvedPath = harnessSkillPath;
  }

  if (!resolvedPath) {
    emitNervesEvent({
      level: "error",
      event: "repertoire.error",
      component: "repertoire",
      message: "skill not found",
      meta: {
        operation: "loadSkill",
        skill: skillName,
        checkedPaths: [directSkillPath, protocolMirrorPath, harnessSkillPath],
      },
    });
    throw new Error(
      `skill '${skillName}' not found in:\n` +
      `- ${directSkillPath}\n` +
      `- ${protocolMirrorPath}\n` +
      `- ${harnessSkillPath}`
    );
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");

  if (!loadedSkills.includes(skillName)) {
    loadedSkills.push(skillName);
  }

  emitNervesEvent({
    event: "repertoire.load_end",
    component: "repertoire",
    message: "loaded skill",
    meta: { operation: "loadSkill", skill: skillName, path: resolvedPath },
  });
  return content;
}

export function getLoadedSkills(): string[] {
  return [...loadedSkills];
}

export function clearLoadedSkills(): void {
  loadedSkills.length = 0;
}
