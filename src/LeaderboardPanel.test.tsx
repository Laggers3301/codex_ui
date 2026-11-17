import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaderboardPanel, leaderboardPercent, leaderboardPersonName } from "./LeaderboardPanel";
import type { CodexLeaderboard } from "./types";

vi.mock('../shared/memberDirectory.js', () => { const names: Record<string, string> = { bob: '乙同学', dave: '丁同学', carol: '丙同学', erin: '戊同学', 'qa-user': '甲同学', heidi: '庚同学', grace: '己同学' }; return { memberDirectory: names, memberRealName: (id: string) => Object.hasOwn(names, id) ? names[id] : null }; });

describe("compact real-name leaderboard", () => {
  it("shows only the person's name and pool quota until their row is opened", () => {
    const board = { currentCycle: { users: [{ userId: "bob", totalTokens: 125000, poolQuotaPercent: 3.25,
      models: [{ model: "gpt-6.1-sol", totalTokens: 125000 }] }] }, lifetime: { users: [] } } as unknown as CodexLeaderboard;
    const html = renderToStaticMarkup(<LeaderboardPanel leaderboard={board} />);
    expect(html).toContain("乙同学");
    expect(html).toContain("3.25%");
    expect(html).not.toContain("125000");
    expect(html).not.toContain("gpt-6.1-sol");
    expect(html).toContain("查看乙同学的模型及额度明细");
  });
  it("marks unresolved names rather than assigning a colleague by a partial abbreviation", () => {
    expect(leaderboardPersonName({ userId: "frank" })).toBe("待核实（frank）");
    expect(leaderboardPersonName({ userId: "dave" })).toBe("丁同学");
    expect(leaderboardPersonName({ userId: "erin" })).toBe("戊同学");
  });
  it("prefers newly recorded names, including corrections to the older roster", () => {
    expect(leaderboardPersonName({ userId: "newuser", displayName: "新用户" })).toBe("新用户");
    expect(leaderboardPersonName({ userId: "bob", displayName: "用户确认姓名" })).toBe("用户确认姓名");
    expect(leaderboardPersonName({ userId: "bob", displayName: " " })).toBe("乙同学");
  });
  it("renders the current and lifetime boards together using their own users and the same row layout", () => {
    const board = { currentCycle: { users: [{ userId: "bob", totalTokens: 100, poolQuotaPercent: 2, models: [] }] },
      lifetime: { users: [{ userId: "dave", totalTokens: 500, poolQuotaPercent: null, models: [] }] } } as unknown as CodexLeaderboard;
    const html = renderToStaticMarkup(<LeaderboardPanel leaderboard={board} />);
    expect(html).toContain('class="leaderboardPanels"');
    expect(html).toContain('data-leaderboard-period="currentCycle"');
    expect(html).toContain('data-leaderboard-period="lifetime"');
    expect(html).toContain("当前周期");
    expect(html).toContain("总榜");
    expect(html).toContain("乙同学");
    expect(html).toContain("丁同学");
    expect(html.match(/class="leaderboardPersonRow"/g)).toHaveLength(2);
  });
  it("does not label unknown quota as zero consumption", () => {
    expect(leaderboardPercent(null)).toBe("—");
    expect(leaderboardPercent(0)).toBe("0%");
    expect(leaderboardPercent(325.7)).toBe("325.7%");
  });
});
