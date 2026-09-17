import { describe, expect, it } from "vitest";
import { parseAgentSeeds } from "../src/agent-seeds";

const agent = {key: "research", name: "Riley", title: "Researcher", description: "Cite sources"};
const encode = (agents: unknown[]) => JSON.stringify({version: 1, agents});
describe("agents.yaml", () => {
  it("parses YAML multiline instructions and portable defaults", () => {
    const [seed] = parseAgentSeeds("version: 1\nagents:\n  - key: research\n    name: Riley\n    title: Researcher\n    description: |\n      Cite sources\n      Explain uncertainty\n");
    expect(seed.bot).toMatchObject({description: "Cite sources\nExplain uncertainty\n", skills: [], routines: [], pluginIds: []});
    expect(seed.modelId).toBeNull();
  });
  it("rejects duplicate seed keys, malformed documents, aliases and resource grants", () => {
    for (const input of [encode([agent, agent]), encode([{...agent, defaultBindings: [1]}]),
      "version: 1\nversion: 1\nagents: []", "version: 1\nagents: [&a {key: a}, *a]",
      "version: 1\nagents: !!js/function 'bad'", "x".repeat(65537)]) {
      expect(() => parseAgentSeeds(input)).toThrow();
    }
  });
});
