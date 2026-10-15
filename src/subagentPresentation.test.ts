import { describe, expect, it } from "vitest";
import { collectAgents, isActiveAgent, parseAgentOperation, reconcileSubagents } from "./subagentPresentation";
import { mergeTimelineItems } from "./conversationTimeline";

describe("subagent presentation", () => {
  it("renders encrypted spawn as task/model metadata without ciphertext", () => {
    const operation = parseAgentOperation({ id: "a", type: "toolCall", tool: "collaboration.spawn_agent", completed: true,
      input: JSON.stringify({ task_name: "document_backend", model: "gpt-6-luna", message: "gAAAA" + "A".repeat(2000) }), aggregatedOutput: '{"task_name":"/root/document_backend"}' });
    expect(operation?.action).toBe("派发子任务");
    expect(operation?.summary).toBeUndefined();
    expect(operation?.agents[0]).toMatchObject({ model: "gpt-6-luna", state: "dispatched" });
  });
  it("updates states from list_agents, not tool completion", () => {
    const items = [{ id: "a", type: "toolCall", tool: "spawn_agent", input: { task_name: "worker", model: "gpt-6-luna" } },
      { id: "b", type: "toolCall", tool: "list_agents", output: { agents: [{ task_name: "worker", status: "completed" }] } }];
    expect(collectAgents(items)).toHaveLength(1);
    expect(collectAgents(items)[0]).toMatchObject({ name: "worker", state: "completed", model: "gpt-6-luna" });
  });
  it("recognizes native collab metadata and ignores unrelated tools", () => {
    expect(parseAgentOperation({ id: "a", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["agent-thread"], agentsStates: { "agent-thread": { status: "running" } } })?.agents[0].state).toBe("running");
    expect(parseAgentOperation({ id: "a", type: "toolCall", tool: "exec", input: "collaboration.spawn_agent()" })).toBeNull();
  });
  it("distinguishes code-cell waits from named/all-agent waits", () => {
    expect(parseAgentOperation({ id: "cell", type: "toolCall", tool: "functions.wait", input: { cell_id: "42", yield_time_ms: 1000 } })).toBeNull();
    expect(parseAgentOperation({ id: "all", type: "toolCall", tool: "collaboration.wait_agent", input: { timeout_ms: 10000 } })).toMatchObject({ action: "等待子代理", summary: "等待任一子代理的状态更新" });
    expect(parseAgentOperation({ id: "specific", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child-a", "child-b"] })?.agents.map(agent => agent.id)).toEqual(["child-a", "child-b"]);
  });
  it("discovers all thread children without loading their dispatch messages", () => {
    const directory = [
      { id: "a", name: "/root/earlier-worker", parentThreadId: "parent", state: "completed", model: "gpt-6-luna" },
      { id: "b", name: "/root/current-worker", parentThreadId: "parent", state: "running", model: "gpt-6-sol" }
    ];
    expect(reconcileSubagents([], directory).map(agent => [agent.name, agent.state])).toEqual([["/root/earlier-worker", "completed"], ["/root/current-worker", "running"]]);
    expect(reconcileSubagents([{ id: "legacy-a", name: "earlier-worker", state: "dispatched" }], directory)).toHaveLength(2);
    expect(reconcileSubagents([], [])).toEqual([]);
  });
  it("handles actual runtime agent_name / tagged agent_status and excludes the main agent", () => {
    const agents = collectAgents([{ id: "list", type: "toolCall", tool: "collaboration.list_agents", output: { agents: [
      { agent_name: "/root", agent_status: "running" },
      { agent_name: "/root/editor", agent_status: { completed: "编辑器已通过检查" } }
    ] } }]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ state: "completed", summary: "编辑器已通过检查" });
  });
  it("recognizes encrypted legacy spawn arguments even when the tool is generically named", () => {
    const payload = "gAAAAAB" + "ciphertext_".repeat(40);
    const operation = parseAgentOperation({ id: "legacy-exec", type: "toolCall", tool: "exec × 4",
      input: { task_name: "/root/document_backend", model: "gpt-6-luna", fork_turns: "all", message: payload },
      aggregatedOutput: JSON.stringify({ task_name: "/root/document_backend" }) });
    expect(operation?.action).toBe("派发子任务");
    expect(operation?.summary).toBeUndefined();
    expect(operation?.agents[0]).toMatchObject({ name: "/root/document_backend", model: "gpt-6-luna", state: "dispatched" });
    expect(JSON.stringify(operation)).not.toContain(payload);
    expect(parseAgentOperation({ id: "ordinary-exec", type: "toolCall", tool: "exec", input: { command: "npm test" } })).toBeNull();
  });
  it("recognizes legacy agent-list rows inside bounded MCP content text wrappers", () => {
    const content = JSON.stringify({ agents: [
      { agent_name: "/root", agent_status: "running" },
      { agent_name: "/root/editor", agent_status: { completed: "Editor review is complete." } }
    ] });
    const agents = collectAgents([{ id: "generic-list", type: "toolCall", tool: "工具",
      aggregatedOutput: JSON.stringify({ content: [{ type: "text", text: content }] }) }]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "/root/editor", state: "completed", summary: "Editor review is complete." });
    const tooLarge = " ".repeat(128_000) + content;
    expect(parseAgentOperation({ id: "oversized", type: "toolCall", tool: "工具", output: { content: [{ type: "text", text: tooLarge }] } })).toBeNull();
  });
  it("keeps completed and stopped loaded rows without counting stale spawns as active", () => {
    const older = [{ id: "old-spawn", type: "toolCall", tool: "spawn_agent", input: { task_name: "old-worker" } }];
    const current = [{ id: "current-list", type: "toolCall", tool: "list_agents", output: { agents: [
      { task_name: "running-worker", status: "running" },
      { task_name: "finished-worker", status: "completed" },
      { task_name: "stopped-worker", status: "interrupted" },
      { task_name: "failed-worker", status: "failed" }
    ] } }];
    const loaded = collectAgents([...older, ...current]);
    const agents = reconcileSubagents(loaded, [{ id: "old-child-id", name: "/root/old-worker", parentThreadId: "parent", state: "completed" }]);
    expect(agents).toHaveLength(5);
    expect(agents.filter(isActiveAgent).map(agent => agent.name)).toEqual(["running-worker"]);
    expect(agents[0]).toMatchObject({ name: "old-worker", state: "completed" });
    expect(loaded[0].state).toBe("dispatched"); // Never mutate a historical event.
  });
  it("merges live status updates at their actual call position", () => {
    const spawn = { id: "spawn", type: "toolCall", tool: "spawn_agent", input: { task_name: "worker", model: "gpt-6-luna" } };
    const running = { id: "list-1", type: "toolCall", tool: "list_agents", output: { agents: [{ task_name: "worker", status: "running" }] } };
    const completed = { id: "list-2", type: "toolCall", tool: "list_agents", output: { agents: [{ task_name: "worker", status: "completed" }] } };
    const result = collectAgents(mergeTimelineItems([spawn, running, completed], [running]));
    expect(result[0]).toMatchObject({ state: "completed", model: "gpt-6-luna" });
    expect(result.filter(isActiveAgent)).toEqual([]);
    expect(collectAgents([spawn]).filter(isActiveAgent)).toHaveLength(1);
  });
  it("only treats an executing, dispatched or waiting agent as composer activity", () => {
    const states = ["running", "dispatched", "waiting", "completed", "failed", "interrupted", "unknown"] as const;
    expect(states.filter(state => isActiveAgent({ id: state, name: state, state }))).toEqual(["running", "dispatched", "waiting"]);
  });
});
